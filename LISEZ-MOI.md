# Le Cercle TB — mise en ligne (100 % gratuit)

Il faut 2 comptes gratuits : **Google** (pour Firebase) et **GitHub**. Compte environ 30 minutes, à faire une seule fois, de préférence sur ordinateur.

## 1. Firebase : comptes, base de données, notifications
1. Va sur console.firebase.google.com → **Créer un projet** → nom : `cercle-tb` (désactive Google Analytics).
2. **Authentication** → Commencer → **E-mail/Mot de passe** → Activer.
3. **Firestore Database** → Créer une base → mode **production** → choisis un emplacement proche (ex. `europe-west`).
   Onglet **Règles** → colle le contenu du fichier `firestore.rules` → Publier.
4. ⚙️ **Paramètres du projet** → Général → en bas, ajoute une **application Web** (icône `</>`), nom `cercle-tb`.
   Copie le bloc `firebaseConfig` dans le fichier `firebase-config.js`.
5. ⚙️ Paramètres → **Cloud Messaging** → *Certificats Web push* → **Générer une paire de clés**.
   Copie la clé dans `vapidKey` du fichier `firebase-config.js`.
6. ⚙️ Paramètres → **Comptes de service** → **Générer une nouvelle clé privée** → un fichier `.json` se télécharge. Garde-le secret.

## 2. GitHub : mettre l'app en ligne
1. Sur github.com → **New repository** → nom `cercle-tb` → **Public** → Create.
2. **Add file → Upload files** → glisse TOUT le contenu du dossier (y compris le dossier `.github`) → Commit.
   Si le dossier `.github` n'est pas parti (dossier caché) : **Add file → Create new file**, nom `.github/workflows/rappels.yml`, colle le contenu du fichier → Commit.
3. **Settings → Pages** → Source : *Deploy from a branch* → branche `main`, dossier `/ (root)` → Save.
   Après 1 à 2 minutes, ton lien apparaît : `https://TON-PSEUDO.github.io/cercle-tb/`
4. **Settings → Secrets and variables → Actions → New repository secret**
   Nom : `FIREBASE_SERVICE_ACCOUNT` — Valeur : tout le contenu du fichier `.json` de l'étape 1.6.
5. Retour dans Firebase → **Authentication → Paramètres → Domaines autorisés** → ajoute `TON-PSEUDO.github.io`.

## 3. Tester les rappels
GitHub → onglet **Actions** → *Rappels* → **Run workflow** → choisis un type → Run.
Les téléphones qui ont activé les rappels reçoivent la notification. Ensuite tout part seul aux heures prévues.

## 4. Partager avec les membres
Envoie le lien. Chacun :
- **Android** : ouvre le lien dans Chrome → menu ⋮ → *Installer l'application*.
- **iPhone** : ouvre le lien dans Safari → Partager → *Sur l'écran d'accueil* → ouvre l'app depuis l'icône.
Puis : créer son compte (prénom, e-mail, mot de passe) → menu ⋮ → **Activer les rappels**.

## Bon à savoir
- La 1re connexion demande internet. Ensuite l'app s'ouvre, se lit et publie sans réseau ; tout part dès que le réseau revient.
- Les rappels arrivent quand le téléphone capte (même quelques secondes), avec parfois quelques minutes de décalage.
- Sur iPhone, les rappels marchent à partir d'iOS 16.4 et seulement depuis l'icône sur l'écran d'accueil.
- Limites gratuites largement suffisantes pour un groupe de plusieurs centaines de personnes.
