# Afterhours: Truth & Dare

A real-time, Firebase-backed multiplayer prototype. Room events are shared only after an explicit audience choice. Firestore rules separate room broadcasts, recipient-only shares, and owner-only private answers.

## Configure Firebase

1. Create a Firebase project and register a Web app.
2. Enable **Email/Password** under Authentication providers.
3. Create a Firestore database.
4. Copy `.env.example` to `.env.local` and fill in the Firebase Web app configuration values.
5. Select your Firebase project with `npx firebase-tools use --add`.
6. Deploy the Firestore rules and Friend ID functions with `npx firebase-tools deploy --only firestore:rules,functions`. Cloud Functions deployment requires the Firebase project to use the Blaze billing plan.
7. Install and run the app with `npm install` and `npm run dev`.

Run the Firestore privacy checks with `npm run test:rules`. The first run downloads Firebase CLI and the Firestore emulator if they are not already available; a Java 21+ runtime is required to start the emulator.

Firebase Web configuration is intended to be public. Access control is enforced by `firestore.rules`; do not replace those rules with open development rules. Do not place service-account credentials in this app.

## Friend IDs

Friend IDs are allocated by the authenticated `allocateFriendId` callable and the Firebase Authentication user-created trigger. Both use one Firestore transaction against `systemCounters/friendIds`, so concurrent allocations cannot issue the same sequence number. The first allocated ID is `SC-000001`; IDs use six digits and stop at `SC-999999`. The Auth UID remains the internal identity and is still used for room membership and existing UID invitations. Firestore rules prevent clients from creating or changing the profile's `friendId`.

Deploy the functions before expecting IDs to appear in profiles. Existing profile Friend IDs are retained; when the counter is first initialized, the allocator checks existing profiles so it continues above any valid `SC-######` value already stored. The callable also backfills users created before the trigger was deployed when they next sign in.

## Privacy model

- Room-wide events live under the sender's room membership and require explicit `Everyone in the room` sharing.
- Selected shares are written only into each selected member's inbox path; only that member can read that path.
- Private answers are written under the signed-in owner's user path; no room member, listener, or host can read them.
- Listener membership is rejected when the host disables listeners. Hosts can remove and ban listeners.
- User blocks are checked by the Firestore rules on room events, invitations, and selected shares. Reports are write-only to the reporting client.
- The prototype does not record conversations. Voice transport is not enabled; microphone access is never requested.

Deploy and test the rules in the Firebase Emulator Suite before production use. Room IDs act as join codes, so share them only with intended participants; UID invitations are also available.