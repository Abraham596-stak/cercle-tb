import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const m = (await db.collection("members").where("email", "==", "tokpomyria@gmail.com").get()).docs[0];
const d = m.data(), a = (await db.collection("assist").doc(m.id).get()).data() || {};
const f = t => t ? new Date(t + 3600e3).toISOString().replace("T", " ").slice(0, 16) : "-";
console.log(`::notice::pause jusqu'au ${f(d.emailPause)} · off=${!!d.emailOff} · raison=${d.emailRaison} · installé=${!!d.installed} · guide=${a.tuto} le ${a.tutoDay} · installN=${a.installN} le ${a.installDay}`);
