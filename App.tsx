import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
} from 'firebase/auth'
import type { User as FirebaseUser } from 'firebase/auth'
import { httpsCallable } from 'firebase/functions'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore'
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowLeft,
  Check,
  ChevronRight,
  CircleHelp,
  Copy,
  DoorOpen,
  Eye,
  Flame,
  Gamepad2,
  Link2,
  LockKeyhole,
  LogOut,
  MessageCircle,
  MicOff,
  Plus,
  Radio,
  Send,
  Shield,
  ShieldAlert,
  Sparkles,
  UserPlus,
  Users,
  VolumeX,
  X,
} from 'lucide-react'
import { auth, db, firebaseConfigured, functions } from './firebase'
import { copy } from './copy'

type Role = 'player' | 'listener'
type Visibility = 'room' | 'selected' | 'private'
type Member = { uid: string; displayName: string; role: Role; joinedAt?: unknown }
type Room = {
  roomCode: string
  hostUid: string
  name: string
  status: 'waiting' | 'active' | 'ended'
  allowListeners: boolean
  spectatorModeEnabled?: boolean
}
type GameEvent = {
  id: string
  senderUid: string
  senderName: string
  kind: 'message' | 'answer' | 'dare_result' | 'game_prompt'
  visibility: 'room' | 'selected'
  content: string
  createdAt?: { toMillis?: () => number } | null
  recipientUid?: string
}
type Invite = { roomId: string; roomName: string; hostUid: string }
type Notice = { text: string; kind: 'good' | 'bad' | 'plain' }

const truths = [
  'What’s a tiny thing you pretend not to care about, but absolutely do?',
  'What’s the most unserious reason you’ve ever had a crush?',
  'What’s a song you know every word to but would never put on aux?',
  'What’s your most chaotic “I can explain” moment?',
  'What’s a harmless hill you’re fully willing to die on?',
  'What’s the last thing you searched that made you pause?',
  'Who here would you trust with your most random secret?',
  'What’s your funniest almost-texted-the-wrong-person moment?',
]

const dares = [
  'Give the group a dramatic weather report for your current location.',
  'Do your best impression of someone ordering at a drive-through.',
  'Rename yourself with the last emoji you used for one round.',
  'Give a 10-second acceptance speech for an award you made up.',
  'Describe your day like it’s a movie trailer. Extra drama encouraged.',
  'Let the group pick a harmless word you have to work into your next sentence.',
  'Do a tiny celebration dance. Camera optional, confidence required.',
  'Say one genuinely nice thing about the person who went before you.',
]

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const values = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join('')
}

function readableError(error: unknown) {
  const code = (error as { code?: string })?.code ?? ''
  if (code.includes('auth/invalid-credential')) return 'That email and password combo didn’t work.'
  if (code.includes('auth/email-already-in-use')) return 'That email already has an account. Try signing in.'
  if (code.includes('auth/weak-password')) return 'Use a password with at least 6 characters.'
  if (code.includes('auth/user-not-found')) return 'No account matches that email yet.'
  if (code.includes('auth/popup-closed-by-user')) return 'Google sign-in was canceled. Try again when you’re ready.'
  if (code.includes('auth/network-request-failed')) return 'Network issue. Check your connection and try again.'
  if (code.includes('permission-denied')) return 'Firebase blocked that action. Check room access and deployed Firestore rules.'
  if (code.includes('not-found')) return 'Couldn’t find that room. Double-check the code.'
  return error instanceof Error ? error.message : 'Something went wrong. Give it another try.'
}

async function upsertUserProfile(user: FirebaseUser, usernameOverride?: string) {
  if (!db) return
  const profileName = (usernameOverride || user.displayName || user.email?.split('@')[0] || 'Player').trim()
  const profileRef = doc(db, 'users', user.uid)
  await setDoc(profileRef, {
    uid: user.uid,
    username: profileName,
    email: user.email ?? '',
    photoURL: user.photoURL ?? '',
    lastSeen: serverTimestamp(),
    online: true,
  }, { merge: true })
}

async function allocateFriendId() {
  if (!functions) throw new Error('Firebase Functions is not configured.')
  const allocate = httpsCallable<void, { friendId: string }>(functions, 'allocateFriendId')
  const result = await allocate()
  return result.data.friendId
}

async function signInWithGoogle() {
  if (!auth) return
  const provider = new GoogleAuthProvider()
  const credential = await signInWithPopup(auth, provider)
  await upsertUserProfile(credential.user, credential.user.displayName || credential.user.email?.split('@')[0])
}

async function handlePasswordReset(emailAddress: string) {
  if (!auth || !emailAddress.trim()) return
  await sendPasswordResetEmail(auth, emailAddress.trim())
}

function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null)
  const [profileName, setProfileName] = useState('')
  const [friendId, setFriendId] = useState('')
  const [roomId, setRoomId] = useState('')
  const [room, setRoom] = useState<Room | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [events, setEvents] = useState<GameEvent[]>([])
  const [inbox, setInbox] = useState<GameEvent[]>([])
  const [invitations, setInvitations] = useState<Invite[]>([])
  const [blockedIds, setBlockedIds] = useState<string[]>([])
  const [mutedIds, setMutedIds] = useState<string[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [authMode, setAuthMode] = useState<'signup' | 'signin'>('signup')
  const [authName, setAuthName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [joinRole, setJoinRole] = useState<Role>('player')
  const [roomName, setRoomName] = useState('Friday energy')
  const [inviteUid, setInviteUid] = useState('')
  const [prompt, setPrompt] = useState('')
  const [turnKind, setTurnKind] = useState<'truth' | 'dare' | ''>('')
  const [answer, setAnswer] = useState('')
  const [answerVisibility, setAnswerVisibility] = useState<Visibility>('room')
  const [message, setMessage] = useState('')
  const [messageVisibility, setMessageVisibility] = useState<Visibility>('room')
  const [selectedUids, setSelectedUids] = useState<string[]>([])
  const [showInvite, setShowInvite] = useState(false)
  const [showPrivacy, setShowPrivacy] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)

  const isHost = Boolean(user && room && room.hostUid === user.uid)
  const self = members.find((member) => member.uid === user?.uid)
  const visibleEvents = [...events, ...inbox]
    .filter((event) => !mutedIds.includes(event.senderUid) && !blockedIds.includes(event.senderUid))
    .sort((left, right) => (left.createdAt?.toMillis?.() ?? 0) - (right.createdAt?.toMillis?.() ?? 0))
  const playerMembers = members.filter((member) => member.role === 'player')
  const listenerMembers = members.filter((member) => member.role === 'listener')

  function tell(text: string, kind: Notice['kind'] = 'good') {
    setNotice({ text, kind })
    window.setTimeout(() => setNotice(null), 3800)
  }

  useEffect(() => {
    if (!auth) return
    return onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser)
      if (nextUser) {
        const nextName = nextUser.displayName || nextUser.email?.split('@')[0] || 'Player'
        setProfileName(nextName)
        try {
          await upsertUserProfile(nextUser, nextName)
          const allocatedFriendId = await allocateFriendId()
          if (auth?.currentUser?.uid === nextUser.uid) setFriendId(allocatedFriendId)
        } catch (error) {
          if (auth?.currentUser?.uid === nextUser.uid) tell(readableError(error), 'bad')
        }
      } else {
        setFriendId('')
        setRoomId('')
        setRoom(null)
        setMembers([])
      }
    })
  }, [])

  useEffect(() => {
    if (!user || !db) {
      setFriendId('')
      return
    }
    return onSnapshot(doc(db, 'users', user.uid), (snapshot) => {
      setFriendId((snapshot.data()?.friendId as string | undefined) ?? '')
    }, (error) => tell(readableError(error), 'bad'))
  }, [user])

  useEffect(() => {
    if (!user || !db) return
    const userRef = doc(db, 'users', user.uid)
    const unsubBlocks = onSnapshot(collection(userRef, 'blocks'), (snapshot) => {
      setBlockedIds(snapshot.docs.map((entry) => entry.id))
    })
    const unsubInvites = onSnapshot(collection(userRef, 'invitations'), (snapshot) => {
      setInvitations(snapshot.docs.map((entry) => entry.data() as Invite))
    })
    return () => {
      unsubBlocks()
      unsubInvites()
    }
  }, [user])

  useEffect(() => {
    if (!roomId || !db) return
    const roomRef = doc(db, 'rooms', roomId)
    const unsubRoom = onSnapshot(roomRef, (snapshot) => {
      if (!snapshot.exists()) {
        setRoom(null)
        return
      }
      setRoom(snapshot.data() as Room)
    }, (error) => tell(readableError(error), 'bad'))
    const unsubMembers = onSnapshot(collection(roomRef, 'members'), (snapshot) => {
      setMembers(snapshot.docs.map((entry) => entry.data() as Member))
    }, (error) => {
      if ((error as { code?: string }).code === 'permission-denied') {
        setRoomId('')
        setRoom(null)
        tell('You no longer have access to this room.', 'plain')
      } else {
        tell(readableError(error), 'bad')
      }
    })
    return () => {
      unsubRoom()
      unsubMembers()
    }
  }, [roomId])

  useEffect(() => {
    if (!roomId || !user || !db || members.length === 0) {
      setEvents([])
      return
    }
    const firestore = db
    const snapshotsBySender = new Map<string, GameEvent[]>()
    const subscriptions = members.map((member) => onSnapshot(
      collection(firestore, 'rooms', roomId, 'members', member.uid, 'sharedEvents'),
      (snapshot) => {
        snapshotsBySender.set(member.uid, snapshot.docs.map((entry) => ({
          id: entry.id,
          ...entry.data(),
        }) as GameEvent))
        setEvents(Array.from(snapshotsBySender.values()).flat())
      },
    ))
    const inboxSubscriptions = members
      .filter((member) => member.uid !== user.uid)
      .map((member) => onSnapshot(
        collection(firestore, 'rooms', roomId, 'members', user.uid, 'inboxFrom', member.uid, 'events'),
        (snapshot) => {
          setInbox((previous) => {
            const keep = previous.filter((event) => event.senderUid !== member.uid)
            return [...keep, ...snapshot.docs.map((entry) => ({
              id: entry.id,
              recipientUid: user.uid,
              ...entry.data(),
            }) as GameEvent)]
          })
        },
      ))
    return () => {
      subscriptions.forEach((unsubscribe) => unsubscribe())
      inboxSubscriptions.forEach((unsubscribe) => unsubscribe())
      setInbox([])
    }
  }, [roomId, user, members])

  async function submitAuth(event: FormEvent) {
    event.preventDefault()
    if (!auth || !db) return
    setBusy(true)
    try {
      if (authMode === 'signup') {
        const credential = await createUserWithEmailAndPassword(auth, email.trim(), password)
        const name = authName.trim() || email.split('@')[0]
        await updateProfile(credential.user, { displayName: name })
        await upsertUserProfile(credential.user, name)
        setProfileName(name)
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password)
      }
      tell('You’re in. Pick a room or start one 🤝')
    } catch (error) {
      tell(readableError(error), 'bad')
    } finally {
      setBusy(false)
    }
  }

  async function submitPasswordReset() {
    const trimmed = email.trim()
    if (!trimmed) return tell('Enter your email to receive a reset link.', 'plain')
    setBusy(true)
    try {
      await handlePasswordReset(trimmed)
      tell('Password reset email sent. Check your inbox.', 'good')
    } catch (error) {
      tell(readableError(error), 'bad')
    } finally {
      setBusy(false)
    }
  }

  async function handleGoogleAuth() {
    if (!auth) return
    setBusy(true)
    try {
      await signInWithGoogle()
      tell('Google account connected. Ready to play.', 'good')
    } catch (error) {
      tell(readableError(error), 'bad')
    } finally {
      setBusy(false)
    }
  }

  async function createRoom(event: FormEvent) {
    event.preventDefault()
    if (!db || !user) return
    setBusy(true)
    const code = makeRoomCode()
    const name = roomName.trim() || 'Friday energy'
    try {
      await setDoc(doc(db, 'rooms', code), {
        roomCode: code,
        hostUid: user.uid,
        name,
        status: 'waiting',
        allowListeners: true,
        spectatorModeEnabled: true,
        createdAt: serverTimestamp(),
      })
      await setDoc(doc(db, 'rooms', code, 'members', user.uid), {
        uid: user.uid,
        displayName: profileName || user.displayName || 'Player',
        role: 'player',
        joinedAt: serverTimestamp(),
      })
      setRoomId(code)
      tell(copy.roomReady)
    } catch (error) {
      tell(readableError(error), 'bad')
    } finally {
      setBusy(false)
    }
  }

  async function joinRoom(codeValue: string, role: Role) {
    if (!db || !user) return
    const code = codeValue.trim().toUpperCase()
    if (!code) return tell('Drop in a room code first 👀', 'plain')
    setBusy(true)
    try {
      const roomRef = doc(db, 'rooms', code)
      const roomSnapshot = await getDoc(roomRef)
      if (!roomSnapshot.exists()) throw new Error('Couldn’t find that room. Double-check the code.')
      const roomData = roomSnapshot.data() as Room
      if (roomData.status === 'ended') throw new Error('This game has ended. Ask the host to start another round.')
      if (role === 'listener' && !(roomData.allowListeners || roomData.spectatorModeEnabled)) throw new Error('Listeners are turned off for this room.')
      const memberRef = doc(roomRef, 'members', user.uid)
      const memberSnapshot = await getDoc(memberRef)
      if (!memberSnapshot.exists()) {
        await setDoc(memberRef, {
          uid: user.uid,
          displayName: profileName || user.displayName || 'Player',
          role,
          joinedAt: serverTimestamp(),
        })
      }
      setRoomId(code)
      setJoinCode('')
      await deleteDoc(doc(db, 'users', user.uid, 'invitations', code)).catch(() => undefined)
      tell(role === 'listener' ? 'You’re in the audience 👀' : 'You’re in. Let’s see what happens 😭')
    } catch (error) {
      tell(readableError(error), 'bad')
    } finally {
      setBusy(false)
    }
  }

  async function changeRoomSetting(field: 'status' | 'allowListeners' | 'spectatorModeEnabled', value: string | boolean) {
    if (!db || !roomId) return
    try {
      await updateDoc(doc(db, 'rooms', roomId), { [field]: value })
      if (field === 'status') tell(value === 'active' ? copy.roundStarted : copy.gameEnded)
      else tell(value ? 'Listeners are welcome in this room 👀' : 'New listeners can’t join now.')
    } catch (error) {
      tell(readableError(error), 'bad')
    }
  }

  async function inviteByUid(event: FormEvent) {
    event.preventDefault()
    if (!db || !user || !room) return
    const targetUid = inviteUid.trim()
    if (!targetUid || targetUid === user.uid) return tell('Add someone else’s UID to invite them 🤝', 'plain')
    try {
      await setDoc(doc(db, 'users', targetUid, 'invitations', roomId), {
        roomId,
        roomName: room.name,
        hostUid: user.uid,
        createdAt: serverTimestamp(),
      })
      setInviteUid('')
      tell('Invite sent. They’ll see it when they log in ✨')
    } catch (error) {
      tell(readableError(error), 'bad')
    }
  }

  async function shareContent(content: string, kind: GameEvent['kind'], visibility: Visibility, clear: () => void) {
    if (!db || !user || !self || !roomId) return
    const firestore = db
    const cleanContent = content.trim()
    if (!cleanContent) return tell('There’s nothing to send yet 😅', 'plain')
    try {
      if (visibility === 'private') {
        await addDoc(collection(firestore, 'users', user.uid, 'privateAnswers'), {
          roomId,
          content: cleanContent,
          createdAt: serverTimestamp(),
        })
        tell(copy.privateSaved)
      } else if (visibility === 'selected') {
        const recipients = selectedUids.filter((uid) => uid !== user.uid)
        if (recipients.length === 0) return tell('Pick at least one person to share with 👀', 'plain')
        const batch = writeBatch(firestore)
        recipients.forEach((uid) => {
          const eventRef = doc(collection(firestore, 'rooms', roomId, 'members', uid, 'inboxFrom', user.uid, 'events'))
          batch.set(eventRef, {
            senderUid: user.uid,
            senderName: self.displayName,
            kind,
            visibility: 'selected',
            content: cleanContent,
            createdAt: serverTimestamp(),
          })
        })
        await batch.commit()
        tell(copy.selectedShared)
      } else {
        await addDoc(collection(firestore, 'rooms', roomId, 'members', user.uid, 'sharedEvents'), {
          senderUid: user.uid,
          senderName: self.displayName,
          kind,
          visibility: 'room',
          content: cleanContent,
          createdAt: serverTimestamp(),
        })
        tell(copy.shared)
      }
      clear()
      setSelectedUids([])
    } catch (error) {
      tell(readableError(error), 'bad')
    }
  }

  async function pickPrompt(kind: 'truth' | 'dare') {
    if (!db || !user || !self || self.role !== 'player' || room?.status !== 'active') return
    const pool = kind === 'truth' ? truths : dares
    const nextPrompt = pool[Math.floor(Math.random() * pool.length)]
    setTurnKind(kind)
    setPrompt(nextPrompt)
    tell(kind === 'truth' ? copy.truthPicked : copy.darePicked)
    try {
      await addDoc(collection(db, 'rooms', roomId, 'members', user.uid, 'sharedEvents'), {
        senderUid: user.uid,
        senderName: self.displayName,
        kind: 'game_prompt',
        visibility: 'room',
        content: `${kind === 'truth' ? 'TRUTH' : 'DARE'}: ${nextPrompt}`,
        createdAt: serverTimestamp(),
      })
    } catch (error) {
      tell(readableError(error), 'bad')
    }
  }

  async function copyText(value: string, success: string) {
    try {
      await navigator.clipboard.writeText(value)
      tell(success)
    } catch {
      tell('Clipboard access is unavailable in this browser.', 'plain')
    }
  }

  async function toggleBlock(targetUid: string) {
    if (!db || !user || targetUid === user.uid) return
    const blockRef = doc(db, 'users', user.uid, 'blocks', targetUid)
    try {
      if (blockedIds.includes(targetUid)) {
        await deleteDoc(blockRef)
        tell('Unblocked. Room sharing is open again.')
      } else {
        await setDoc(blockRef, { createdAt: serverTimestamp() })
        tell(copy.blocked)
      }
    } catch (error) {
      tell(readableError(error), 'bad')
    }
  }

  async function removeListener(targetUid: string) {
    if (!db || !isHost) return
    try {
      const batch = writeBatch(db)
      batch.set(doc(db, 'rooms', roomId, 'bans', targetUid), { uid: targetUid, createdAt: serverTimestamp() })
      batch.delete(doc(db, 'rooms', roomId, 'members', targetUid))
      await batch.commit()
      tell(copy.removed)
    } catch (error) {
      tell(readableError(error), 'bad')
    }
  }

  async function reportMember(targetUid: string) {
    if (!db || !user) return
    const reason = window.prompt('What should the moderators know? Keep it clear and specific.')
    if (!reason?.trim()) return
    try {
      await addDoc(collection(db, 'reports'), {
        reporterUid: user.uid,
        reportedUid: targetUid,
        roomId,
        reason: reason.trim().slice(0, 1000),
        createdAt: serverTimestamp(),
      })
      tell(copy.reported)
    } catch (error) {
      tell(readableError(error), 'bad')
    }
  }

  async function leaveRoom() {
    if (!db || !user || !roomId) return
    try {
      await deleteDoc(doc(db, 'rooms', roomId, 'members', user.uid))
      setRoomId('')
      setRoom(null)
      setMembers([])
      tell('You dipped from the room. Catch you later 🤝')
    } catch (error) {
      tell(readableError(error), 'bad')
    }
  }

  if (!firebaseConfigured) {
    return <SetupScreen />
  }

  if (!user) {
    return (
      <main className="auth-shell">
        <section className="auth-story">
          <div className="brand-mark"><span /><span /><span /></div>
          <p className="eyebrow">PRIVATE MULTIPLAYER GAME</p>
          <h1>TRUTH <span>&amp;</span><br />DARE</h1>
          <p className="story-copy">PLAY. CHOOSE. DARE.<br /><span>Create a private room, invite your friends with UID, and start playing.</span></p>
          <div className="story-stamp"><Shield size={15} /> PRIVATE ROOMS · LIVE PLAY</div>
        </section>
        <section className="auth-panel">
          <div className="auth-topline"><span>✳</span> {authMode === 'signup' ? 'CREATE PLAYER ACCESS' : 'PLAYER ACCESS'}</div>
          <h2>{authMode === 'signup' ? 'Enter the game.' : 'Welcome back.'}</h2>
          <p className="muted">{authMode === 'signup' ? 'Create your account to host or join a private match.' : 'Sign in to continue to your multiplayer lobby.'}</p>
          <form className="stack-form" onSubmit={submitAuth}>
            {authMode === 'signup' && <label>Your name<input required autoComplete="nickname" value={authName} onChange={(event) => setAuthName(event.target.value)} placeholder="What should we call you?" /></label>}
            <label>Email<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label>
            <label>Password<input required minLength={6} type="password" autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 6 characters" /></label>
            <button className="button button-primary button-wide" type="submit" disabled={busy}>{busy ? 'Connecting…' : authMode === 'signup' ? 'Create account' : 'Sign in'} <ChevronRight size={17} /></button>
          </form>
          <div className="auth-utility-row">
            <button type="button" className="text-button" onClick={() => void submitPasswordReset()} disabled={!email.trim() || busy}>Forgot password?</button>
          </div>
          <button type="button" className="button button-secondary button-wide auth-google" onClick={() => void handleGoogleAuth()} disabled={busy}><span className="google-mark">G</span> Continue with Google</button>
          <p className="switch-auth">{authMode === 'signup' ? 'Already have an account?' : 'New around here?'} <button onClick={() => setAuthMode(authMode === 'signup' ? 'signin' : 'signup')}>{authMode === 'signup' ? 'Sign in' : 'Make an account'}</button></p>
          <div className="privacy-foot"><LockKeyhole size={14} /> Your account protects your UID and private answers.</div>
        </section>
        {notice && <Toast notice={notice} />}
      </main>
    )
  }

  if (roomId && room) {
    return (
      <main className="app-shell room-shell">
        <header className="topbar">
          <button className="wordmark" onClick={() => setRoomId('')}><span className="brand-mark mini"><span /><span /><span /></span>TRUTH &amp; DARE</button>
          <div className="topbar-right"><span className="online-pill"><i /> {room.status === 'active' ? 'ROUND LIVE' : 'ROOM OPEN'}</span><button className="icon-button" title="Privacy details" onClick={() => setShowPrivacy((value) => !value)}><Shield size={17} /></button><button className="avatar-button" title="Sign out" onClick={() => void signOut(auth!)}>{(profileName || user.displayName || 'P').slice(0, 1).toUpperCase()}</button></div>
        </header>

        <div className="room-layout">
          <section className="play-column">
            <div className="room-heading">
              <button className="back-link" onClick={() => setRoomId('')}><ArrowLeft size={15} /> LOBBY</button>
              <div className="room-title-row"><div><p className="eyebrow">ROOM ID · {members.length} PLAYERS &amp; SPECTATORS</p><h1>{room.name}</h1><span className="host-line">HOST · {members.find((member) => member.uid === room.hostUid)?.displayName || 'Host'}</span></div><div className="room-heading-actions"><span className="private-indicator"><LockKeyhole size={13} /> PRIVATE ROOM</span><button className="room-code" onClick={() => void copyText(room.roomCode, 'Room ID copied. Share it to invite a player.')}><span>ROOM ID</span><strong>{room.roomCode}</strong><Copy size={15} /></button></div></div>
            </div>

            {showPrivacy && <div className="privacy-banner"><Shield size={18} /><div><strong>Visibility is always your choice.</strong><span>Private answers stay in your account. Selected shares go only to their recipients. Spectators can see only content intentionally shared with the room.</span></div><button className="icon-button" onClick={() => setShowPrivacy(false)} aria-label="Close privacy details"><X size={16} /></button></div>}

            {room.status === 'waiting' ? (
              <section className="waiting-panel"><div className="waiting-art"><div className="waiting-ring"><Gamepad2 size={42} /></div><span className="orbit orbit-one"><Eye size={13} /></span><span className="orbit orbit-two">✳</span></div><p className="eyebrow">LOBBY · {members.length} CONNECTED</p><h2>Players assemble.</h2><p>Share the room ID, then start the match when everyone is ready.</p>{isHost && <button className="button button-primary" onClick={() => void changeRoomSetting('status', 'active')}><Flame size={17} /> Start the game</button>}</section>
            ) : room.status === 'ended' ? (
              <section className="waiting-panel"><div className="waiting-ring finish-ring"><Check size={40} /></div><p className="eyebrow">THAT’S A WRAP</p><h2>{copy.roundOver}</h2><p>Thanks for bringing the energy. Start another room whenever.</p>{isHost && <button className="button button-primary" onClick={() => void changeRoomSetting('status', 'waiting')}><Radio size={16} /> Run it back</button>}</section>
            ) : (
              <>
                <section className={`turn-banner ${turnKind ? `${turnKind}-turn` : ''}`}><div className="turn-icon">{turnKind === 'truth' ? <CircleHelp size={20} /> : turnKind === 'dare' ? <Flame size={19} /> : <Eye size={20} />}</div><div><p className="eyebrow">{turnKind ? `${turnKind.toUpperCase()} CHALLENGE` : 'YOUR MOVE'}</p><strong>{prompt || 'TRUTH OR DARE?'}</strong></div><span className="turn-spark">✳</span></section>
                {self?.role === 'player' ? <div className="choice-row"><button className="choice-button truth-choice" onClick={() => void pickPrompt('truth')}><span className="choice-symbol">?</span><span><small>ANSWER HONESTLY</small><strong>TRUTH</strong></span><ArrowDownLeft size={18} /></button><button className="choice-button dare-choice" onClick={() => void pickPrompt('dare')}><span className="choice-symbol">!</span><span><small>TAKE THE CHALLENGE</small><strong>DARE</strong></span><ArrowDownLeft size={18} /></button></div> : <div className="listener-note"><Eye size={16} /><span><strong>SPECTATOR MODE</strong> · You see room posts and selected shares addressed to you. Private answers stay hidden.</span></div>}

                {self?.role === 'player' && <section className="answer-panel"><div className="section-heading"><div><p className="eyebrow">YOUR MOMENT</p><h2>{copy.answerPrompt}</h2></div><span className="answer-emoji">💬</span></div><textarea value={answer} onChange={(event) => setAnswer(event.target.value)} maxLength={2000} placeholder={turnKind === 'truth' ? 'Say as much or as little as you want…' : 'Drop the result when you’re ready…'} /><VisibilityPicker value={answerVisibility} onChange={setAnswerVisibility} members={members} selectedUids={selectedUids} setSelectedUids={setSelectedUids} currentUid={user.uid} /><button className="button button-primary share-button" onClick={() => void shareContent(answer, turnKind === 'dare' ? 'dare_result' : 'answer', answerVisibility, () => setAnswer(''))} disabled={!answer.trim()}><Send size={16} /> Share your answer</button></section>}
              </>
            )}

            <section className="chat-panel"><div className="section-heading chat-heading"><div><p className="eyebrow">MATCH FEED</p><h2>Shared with the room</h2></div><span className="chat-live"><i /> LIVE</span></div><div className="event-list" aria-live="polite">{visibleEvents.length === 0 ? <div className="empty-chat"><MessageCircle size={21} /><p>{copy.noMessages}</p></div> : visibleEvents.slice(-40).map((event) => <EventRow key={`${event.senderUid}-${event.id}-${event.recipientUid || 'room'}`} event={event} isOwn={event.senderUid === user.uid} onReact={(reaction) => tell(reaction, 'plain')} />)}</div>
              {self?.role === 'player' ? <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); void shareContent(message, 'message', messageVisibility, () => setMessage('')) }}><input value={message} onChange={(event) => setMessage(event.target.value)} maxLength={2000} placeholder="Send a room message…" /><button className="send-button" disabled={!message.trim()} aria-label="Share message"><Send size={17} /></button></form> : <div className="listener-chat-note"><Eye size={15} /> Spectators see room posts and selected shares sent to them, never private answers.</div>}
              {self?.role === 'player' && <VisibilityPicker compact value={messageVisibility} onChange={setMessageVisibility} members={members} selectedUids={selectedUids} setSelectedUids={setSelectedUids} currentUid={user.uid} />}
            </section>
          </section>

          <aside className="side-column">
            <section className="side-card identity-card"><div className="identity-top"><span className="avatar avatar-lime">{(profileName || 'P').slice(0, 1).toUpperCase()}</span><div><strong>{profileName || user.displayName || 'Player'}</strong><span className="role-badge">{self?.role === 'listener' ? 'SPECTATOR' : isHost ? 'HOST · PLAYER' : 'PLAYER'}</span></div><button className="icon-button small" title="Copy your UID" onClick={() => void copyText(user.uid, 'UID copied. Share it to receive an invite.')}><Copy size={15} /></button></div><div className="uid-line"><span>YOUR UID</span><code>{user.uid}</code></div><div className="voice-state"><MicOff size={15} /><span>Voice chat isn’t connected</span><button title={copy.voiceUnavailable} onClick={() => tell(copy.voiceUnavailable, 'plain')}><CircleHelp size={15} /></button></div></section>

            <section className="side-card roster-card"><div className="roster-title"><div><p className="eyebrow">ROOM ROSTER</p><h2>Players <span>{playerMembers.length}</span></h2></div><button className="icon-button small" title="Invite by UID" onClick={() => setShowInvite((value) => !value)}><UserPlus size={17} /></button></div>{showInvite && <form className="invite-form" onSubmit={inviteByUid}><label htmlFor="friend-uid">ENTER FRIEND UID</label><div className="invite-input-row"><input id="friend-uid" value={inviteUid} onChange={(event) => setInviteUid(event.target.value)} placeholder="Paste friend UID" aria-label="Friend UID" /><button aria-label="Send invite"><Send size={15} /></button></div><small>Invitation is delivered to their account.</small></form>}<MemberList members={playerMembers} currentUid={user.uid} hostUid={room.hostUid} isHost={isHost} mutedIds={mutedIds} blockedIds={blockedIds} onMute={(uid) => setMutedIds((previous) => previous.includes(uid) ? previous.filter((entry) => entry !== uid) : [...previous, uid])} onBlock={toggleBlock} onReport={reportMember} onRemove={removeListener} /></section>

            <section className="side-card roster-card listeners-card"><div className="roster-title"><div><p className="eyebrow">SPECTATOR ROSTER</p><h2>Spectators <span>{listenerMembers.length}</span></h2></div><Eye size={17} className="roster-icon" /></div>{listenerMembers.length ? <MemberList members={listenerMembers} currentUid={user.uid} hostUid={room.hostUid} isHost={isHost} mutedIds={mutedIds} blockedIds={blockedIds} onMute={(uid) => setMutedIds((previous) => previous.includes(uid) ? previous.filter((entry) => entry !== uid) : [...previous, uid])} onBlock={toggleBlock} onReport={reportMember} onRemove={removeListener} /> : <p className="empty-roster">No spectators connected.</p>}{isHost && <label className="listener-toggle"><span><strong>Enable spectators</strong><small>Allow spectator seats in this room</small></span><input type="checkbox" checked={room.allowListeners} onChange={(event) => void changeRoomSetting('allowListeners', event.target.checked)} /><i /></label>}</section>

            <section className="host-controls"><div className="host-control-head"><ShieldAlert size={17} /><span>HOST CONTROLS</span></div>{isHost ? <><button onClick={() => setShowInvite((value) => !value)}><UserPlus size={15} /> Invite friend by UID <ChevronRight size={14} /></button><button onClick={() => void copyText(room.roomCode, 'Room ID copied. Share it to invite a player.')}><Link2 size={15} /> Copy room ID <ChevronRight size={14} /></button><button onClick={() => void changeRoomSetting('status', room.status === 'ended' ? 'waiting' : 'ended')}><Gamepad2 size={15} /> {room.status === 'ended' ? 'Start a new match' : 'End match'} <ChevronRight size={14} /></button></> : <p>Controls are managed by {members.find((member) => member.uid === room.hostUid)?.displayName || 'the host'}.</p>}<button className="leave-control" onClick={() => setConfirmLeave(true)}><DoorOpen size={15} /> Leave room <ChevronRight size={14} /></button></section>
          </aside>
        </div>
        {confirmLeave && <div className="modal-backdrop" onClick={() => setConfirmLeave(false)}><section className="privacy-modal leave-modal" role="dialog" aria-modal="true" aria-labelledby="leave-title" onClick={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setConfirmLeave(false)} aria-label="Close"><X size={18} /></button><DoorOpen size={23} /><p className="eyebrow">ROOM EXIT</p><h2 id="leave-title">Leave this room?</h2><p>You’ll be removed from the room roster. You can rejoin later with the room ID if the host still has the room open.</p><div className="modal-actions"><button className="button button-secondary" onClick={() => setConfirmLeave(false)}>Stay here</button><button className="button button-danger" onClick={() => { setConfirmLeave(false); void leaveRoom() }}>Leave room</button></div></section></div>}
        {notice && <Toast notice={notice} />}
      </main>
    )
  }

  return (
    <main className="app-shell lobby-shell">
      <header className="topbar"><button className="wordmark" onClick={() => setRoomId('')}><span className="brand-mark mini"><span /><span /><span /></span>TRUTH &amp; DARE</button><div className="topbar-right"><span className="profile-tag"><span className="avatar avatar-small">{(profileName || 'P').slice(0, 1).toUpperCase()}</span>{profileName || 'Player'}</span><button className="icon-button" title="Sign out" onClick={() => void signOut(auth!)}><LogOut size={17} /></button></div></header>
      <section className="lobby-hero"><div><p className="eyebrow">MULTIPLAYER GAME LOBBY</p><h1>TRUTH <em>OR</em><br />DARE?</h1><p>Create a private room, invite your friends with UID, and start playing.</p><div className="hero-marks"><span><Shield size={14} /> Private rooms</span><span><Radio size={14} /> Live matches</span><span><Eye size={14} /> Spectator mode</span></div></div><div className="hero-sticker"><div className="sticker-core"><span>TRUTH</span><b>OR</b><span>DARE</span></div><span className="sticker-star">✳</span></div></section>
      <section className="profile-strip"><div className="profile-strip-icon"><Users size={19} /></div><div className="profile-strip-copy"><p className="eyebrow">PLAYER PROFILE</p><strong>{profileName || user.displayName || 'Player'}</strong><span>FRIEND ID · <code>{friendId || 'Assigning…'}</code></span><span>AUTH UID · <code>{user.uid}</code></span></div><div className="profile-actions"><button className="button button-secondary" onClick={() => void copyText(friendId, 'Friend ID copied. Share it with your friends.')} disabled={!friendId}><Copy size={15} /> Copy Friend ID</button><button className="button button-secondary" onClick={() => void copyText(user.uid, 'UID copied. Share it to receive an invite.')}><Copy size={15} /> Copy UID</button></div></section>
      <section className="lobby-grid"><div className="lobby-card create-card"><div className="card-overline"><span className="number-tag">01</span><span>CREATE ROOM</span></div><div className="card-icon icon-hot"><Plus size={20} /></div><h2>Host a match</h2><p>Set a room name, invite players by UID, and control spectator access.</p><form className="room-form" onSubmit={createRoom}><label>ROOM NAME<input value={roomName} maxLength={48} onChange={(event) => setRoomName(event.target.value)} placeholder="Name your room" /></label><button className="button button-primary button-wide" disabled={busy}>{busy ? 'Creating room…' : 'Create private room'} <ChevronRight size={17} /></button></form><div className="card-foot"><LockKeyhole size={13} /> Unique room ID · Firebase live sync</div></div>
        <div className="lobby-card join-card"><div className="card-overline"><span className="number-tag">02</span><span>JOIN ROOM</span></div><div className="card-icon icon-cool"><ArrowDownLeft size={20} /></div><h2>Enter a match</h2><p>Use the room ID you received. Choose a player or spectator seat.</p><form className="room-form" onSubmit={(event) => { event.preventDefault(); void joinRoom(joinCode, joinRole) }}><label>ROOM ID<input value={joinCode} maxLength={8} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} placeholder="Enter 8-character ID" /></label><div className="role-switch" aria-label="Join as"><button type="button" className={joinRole === 'player' ? 'selected' : ''} onClick={() => setJoinRole('player')}><Gamepad2 size={15} /> Player</button><button type="button" className={joinRole === 'listener' ? 'selected' : ''} onClick={() => setJoinRole('listener')}><Eye size={15} /> Spectator</button></div><button className="button button-secondary button-wide" disabled={busy}>{busy ? 'Joining…' : 'Join room'} <ChevronRight size={17} /></button></form><div className="card-foot"><Shield size={13} /> Spectators only see room-shared content</div></div>
      </section>
      <section className="invites-section"><div className="invites-heading"><div><p className="eyebrow">ROOM INVITES · {invitations.length}</p><h2>Your rooms</h2></div><span className="invites-side-note"><Users size={15} /> Access by UID invite</span></div>{invitations.length ? <div className="invite-list">{invitations.map((invite) => <div className="invite-item" key={invite.roomId}><div className="invite-room-icon"><Gamepad2 size={18} /></div><div className="invite-info"><strong>{invite.roomName}</strong><span>ROOM ID · {invite.roomId}</span></div><button className="button button-primary" onClick={() => void joinRoom(invite.roomId, 'player')}>Join room <ChevronRight size={15} /></button></div>)}</div> : <div className="no-invites"><Shield size={20} /><span>No room invites yet. Share your UID above to get invited.</span></div>}</section>
      <footer className="lobby-footer"><span>TRUTH &amp; DARE · PRIVATE MULTIPLAYER</span><button onClick={() => setShowPrivacy((value) => !value)}><Shield size={13} /> Privacy</button></footer>
      {showPrivacy && <div className="modal-backdrop" onClick={() => setShowPrivacy(false)}><section className="privacy-modal" onClick={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setShowPrivacy(false)} aria-label="Close"><X size={18} /></button><Shield size={22} /><h2>Private stays private.</h2><p>Choose who can see each answer or message before you share it. Room-wide posts are visible to players and spectators. Selected shares go only to the people you pick. Private answers are stored under your account and are not readable by the room host or other members.</p><p>Spectators can see room posts and selected shares addressed to them. Private answers remain private. Voice chat is not connected.</p><button className="button button-primary" onClick={() => setShowPrivacy(false)}>Understood</button></section></div>}
      {notice && <Toast notice={notice} />}
    </main>
  )
}

function SetupScreen() {
  return <main className="setup-screen"><div className="setup-card"><div className="brand-mark"><span /><span /><span /></div><p className="eyebrow">ALMOST READY</p><h1>Connect Firebase<br />to get in the game.</h1><p>This app uses Firebase Authentication and Firestore for real accounts, live rooms, UID invites, and server-enforced privacy.</p><ol><li>Copy <code>.env.example</code> to <code>.env.local</code>.</li><li>Add your Firebase Web app config values.</li><li>Enable Email/Password sign-in and deploy <code>firestore.rules</code>.</li></ol><div className="setup-safe"><LockKeyhole size={16} /> No demo mode. The game won’t pretend a local room is multiplayer.</div></div></main>
}

function VisibilityPicker({ value, onChange, members, selectedUids, setSelectedUids, currentUid, compact = false }: {
  value: Visibility
  onChange: (value: Visibility) => void
  members: Member[]
  selectedUids: string[]
  setSelectedUids: (value: string[]) => void
  currentUid: string
  compact?: boolean
}) {
  const otherMembers = members.filter((member) => member.uid !== currentUid)
  return <div className={`visibility-picker ${compact ? 'visibility-compact' : ''}`}>
    <span className="visibility-label"><Eye size={14} /> SHARE WITH</span>
    <div className="visibility-options">
      <button type="button" className={value === 'room' ? 'active' : ''} onClick={() => onChange('room')}><Users size={13} /> Everyone</button>
      <button type="button" className={value === 'selected' ? 'active' : ''} onClick={() => onChange('selected')}><UserPlus size={13} /> Selected people</button>
      <button type="button" className={value === 'private' ? 'active' : ''} onClick={() => onChange('private')}><LockKeyhole size={13} /> Private</button>
    </div>
    <p className="visibility-explain">{value === 'room' ? 'Players and spectators in this room can see it.' : value === 'selected' ? 'Only the people you pick can see it.' : 'Only you can read it. Not even the host.'}</p>
    {value === 'selected' && <div className="recipient-list">{otherMembers.map((member) => <label key={member.uid}><input type="checkbox" checked={selectedUids.includes(member.uid)} onChange={(event) => setSelectedUids(event.target.checked ? [...selectedUids, member.uid] : selectedUids.filter((uid) => uid !== member.uid))} /><span>{member.displayName}</span><small>{member.role === 'listener' ? copy.listenerBadge : 'Player'}</small></label>)}</div>}
  </div>
}

function EventRow({ event, isOwn, onReact }: { event: GameEvent; isOwn: boolean; onReact: (reaction: string) => void }) {
  const isPrompt = event.kind === 'game_prompt'
  const isAnswer = event.kind === 'answer' || event.kind === 'dare_result'
  const badge = isPrompt ? 'THE PROMPT' : event.kind === 'dare_result' ? 'DARE RESULT' : event.kind === 'answer' ? 'TRUTH ANSWER' : event.visibility === 'selected' ? 'SELECTED SHARE' : 'ROOM MESSAGE'
  return <article className={`event-row ${isOwn ? 'own-event' : ''} ${isPrompt ? 'prompt-event' : ''}`}><span className={`event-avatar ${isPrompt ? 'prompt-avatar' : ''}`}>{isPrompt ? <Sparkles size={15} /> : event.senderName.slice(0, 1).toUpperCase()}</span><div className="event-body"><div className="event-meta"><strong>{isOwn ? 'You' : event.senderName}</strong><span>{badge}</span></div><p>{event.content}</p>{!isAnswer && !isPrompt && <div className="reaction-row">{['😂', '😭', '🔥', '👀'].map((reaction) => <button key={reaction} title={`React ${reaction}`} onClick={() => onReact(`${reaction} reaction sent. W energy 🤝`)}>{reaction}</button>)}</div>}</div></article>
}

function MemberList({ members, currentUid, hostUid, isHost, mutedIds, blockedIds, onMute, onBlock, onReport, onRemove }: {
  members: Member[]
  currentUid: string
  hostUid: string
  isHost: boolean
  mutedIds: string[]
  blockedIds: string[]
  onMute: (uid: string) => void
  onBlock: (uid: string) => void
  onReport: (uid: string) => void
  onRemove: (uid: string) => void
}) {
  return <div className="member-list">{members.map((member, index) => <div className="member-row" key={member.uid}><span className={`avatar member-avatar avatar-${index % 4}`}>{member.displayName.slice(0, 1).toUpperCase()}</span><div className="member-name"><strong>{member.displayName}{member.uid === currentUid ? ' (you)' : ''}</strong><span className={`member-role ${member.uid === hostUid ? 'host-role' : member.role === 'listener' ? 'spectator-role' : 'player-role'}`}>{member.uid === hostUid ? 'HOST · PLAYER' : member.role === 'listener' ? 'SPECTATOR' : 'PLAYER'}</span></div>{member.uid !== currentUid && <div className="member-actions"><button className={mutedIds.includes(member.uid) ? 'action-on' : ''} title={mutedIds.includes(member.uid) ? 'Unmute this person in your view' : 'Mute this person in your view'} onClick={() => onMute(member.uid)}><VolumeX size={14} /></button><button className={blockedIds.includes(member.uid) ? 'action-on' : ''} title={blockedIds.includes(member.uid) ? 'Unblock' : 'Block'} onClick={() => onBlock(member.uid)}><ShieldAlert size={14} /></button><button title="Report to moderators" onClick={() => onReport(member.uid)}><AlertTriangle size={14} /></button>{isHost && member.role === 'listener' && <button title="Remove and block spectator" onClick={() => onRemove(member.uid)}><X size={14} /></button>}</div>}</div>)}</div>
}

function Toast({ notice }: { notice: Notice }) {
  return <div className={`toast toast-${notice.kind}`} role="status"><span>{notice.kind === 'bad' ? <AlertTriangle size={16} /> : notice.kind === 'good' ? <Check size={16} /> : <Sparkles size={16} />}</span>{notice.text}</div>
}

export default App