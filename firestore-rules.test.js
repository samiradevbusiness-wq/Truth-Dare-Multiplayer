import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore'

let environment

before(async () => {
  environment = await initializeTestEnvironment({
    projectId: 'afterhours-rules-test',
    firestore: {
      rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'),
    },
  })
  await environment.withSecurityRulesDisabled(async (context) => {
    const database = context.firestore()
    await setDoc(doc(database, 'rooms', 'ROOM1234'), {
      roomCode: 'ROOM1234',
      hostUid: 'host',
      name: 'Test room',
      status: 'active',
      allowListeners: true,
    })
    for (const [uid, role] of [['host', 'player'], ['player', 'player'], ['listener', 'listener'], ['recipient', 'player']]) {
      await setDoc(doc(database, 'rooms', 'ROOM1234', 'members', uid), {
        uid,
        displayName: uid,
        role,
      })
    }
    await setDoc(doc(database, 'rooms', 'ROOM1234', 'members', 'player', 'sharedEvents', 'public-post'), {
      senderUid: 'player',
      senderName: 'player',
      kind: 'answer',
      visibility: 'room',
      content: 'Shared with everyone',
    })
    await setDoc(doc(database, 'rooms', 'ROOM1234', 'members', 'recipient', 'inboxFrom', 'player', 'events', 'selected-post'), {
      senderUid: 'player',
      senderName: 'player',
      kind: 'answer',
      visibility: 'selected',
      content: 'Only for the recipient',
    })
    await setDoc(doc(database, 'users', 'player', 'privateAnswers', 'private-answer'), {
      roomId: 'ROOM1234',
      content: 'Only the owner can read this',
    })
  })
})

after(async () => {
  await environment?.cleanup()
})

test('listeners can read room-shared events', async () => {
  const database = environment.authenticatedContext('listener').firestore()
  await assertSucceeds(getDoc(doc(database, 'rooms', 'ROOM1234', 'members', 'player', 'sharedEvents', 'public-post')))
})

test('selected events are readable only by their recipient', async () => {
  const recipientDatabase = environment.authenticatedContext('recipient').firestore()
  const listenerDatabase = environment.authenticatedContext('listener').firestore()
  const inboxPath = ['rooms', 'ROOM1234', 'members', 'recipient', 'inboxFrom', 'player', 'events', 'selected-post']
  await assertSucceeds(getDoc(doc(recipientDatabase, ...inboxPath)))
  await assertFails(getDoc(doc(listenerDatabase, ...inboxPath)))
})

test('private answers are readable only by their owner', async () => {
  const ownerDatabase = environment.authenticatedContext('player').firestore()
  const listenerDatabase = environment.authenticatedContext('listener').firestore()
  const answerPath = ['users', 'player', 'privateAnswers', 'private-answer']
  await assertSucceeds(getDoc(doc(ownerDatabase, ...answerPath)))
  await assertFails(getDoc(doc(listenerDatabase, ...answerPath)))
})

test('listeners cannot publish room gameplay events', async () => {
  const database = environment.authenticatedContext('listener').firestore()
  await assertFails(setDoc(doc(database, 'rooms', 'ROOM1234', 'members', 'listener', 'sharedEvents', 'listener-post'), {
    senderUid: 'listener',
    senderName: 'listener',
    kind: 'message',
    visibility: 'room',
    content: 'A listener should not publish this',
  }))
})

test('users cannot choose their own Friend ID during profile creation', async () => {
  const database = environment.authenticatedContext('new-user').firestore()
  await assertFails(setDoc(doc(database, 'users', 'new-user'), {
    uid: 'new-user',
    friendId: 'SC-000001',
  }))
})

test('users cannot add or change their Friend ID after profile creation', async () => {
  const database = environment.authenticatedContext('profile-owner').firestore()
  const profile = doc(database, 'users', 'profile-owner')
  await assertSucceeds(setDoc(profile, { uid: 'profile-owner', username: 'Player' }))
  await assertFails(updateDoc(profile, { friendId: 'SC-000001' }))

  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users', 'friend-id-owner'), {
      uid: 'friend-id-owner',
      username: 'Player',
      friendId: 'SC-000002',
    })
  })
  const existingProfile = doc(database, 'users', 'friend-id-owner')
  await assertFails(updateDoc(existingProfile, { friendId: 'SC-000003' }))
  await assertSucceeds(updateDoc(existingProfile, { username: 'Updated player' }))
})

test('clients cannot access the Friend ID allocation counter', async () => {
  const database = environment.authenticatedContext('client').firestore()
  const counter = doc(database, 'systemCounters', 'friendIds')
  await assertFails(getDoc(counter))
  await assertFails(setDoc(counter, { lastIssued: 100 }))
})