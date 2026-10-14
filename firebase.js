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

const db = admin.firestore();

console.log("✅ Firebase connected");

module.exports = db;
module.exports.db = db;
