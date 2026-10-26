const admin = require("firebase-admin");

if (!process.env.FIREBASE_KEY) {
  console.error("❌ FIREBASE_KEY environment variable missing!");
  process.exit(1);
}

let serviceAccount;

try {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
  console.log("✅ Firebase key loaded");
} catch (error) {
  console.error("❌ Firebase JSON parsing failed:", error.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const nativeDb = admin.firestore();
const { createResilientFirestore } = require("./lib/firestoreResilience");
const db = createResilientFirestore(nativeDb, admin);

console.log("✅ Firebase connected");

// The resilience proxy also exposes a compatible `.db` property for destructuring imports.
module.exports = db;
