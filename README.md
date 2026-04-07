# 📚 Courses Glance

A personal PDF study web app with highlights, bookmarks, and Firebase sync.

---

## Features

| Feature | Details |
|---------|---------|
| 🔐 Secure Login | Firebase Email/Password auth — only you get in |
| 📄 18 PDF Courses | Click any course to open the full viewer |
| 🖊️ Highlight Text | Select text → it highlights in 5 colours |
| 🗑️ Erase Highlights | One-click removal of any saved highlight |
| ☁️ Cloud Sync | All highlights saved to Firestore, load on every visit |
| 📑 Thumbnails | Page thumbnail sidebar for quick navigation |
| 🔖 Bookmarks | Bookmark any page, persisted per-PDF |
| 🔍 Search | Find pages containing a keyword |
| ↩️ Resume | Automatically reopens at your last position |
| 🌙 Dark Mode | Toggle dark/light — preference saved locally |
| ⌨️ Keyboard Shortcuts | Full keyboard navigation (see below) |

---

## Quick Setup

### 1 — Add your PDFs

Place all 18 PDF files in the `pdfs/` folder:

```
pdfs/
  CHE110.pdf
  CSE101.pdf
  MAT101.pdf
  PHY101.pdf
  ENG101.pdf
  BIO101.pdf
  HIS101.pdf
  ECO101.pdf
  PSY101.pdf
  SOC101.pdf
  MAT102.pdf
  PHY102.pdf
  CHE111.pdf
  CSE102.pdf
  ENG102.pdf
  BIO102.pdf
  ECO102.pdf
  PHI101.pdf
```

> To rename or change courses, edit the `COURSES` array in `dashboard.html`.

---

### 2 — Firebase Setup

#### Authentication
1. Go to [Firebase Console](https://console.firebase.google.com)
2. Open **courses-glance-a3388**
3. Authentication → Sign-in method → Enable **Email/Password**
4. Authentication → Users → **Add User** → Enter your email + password

#### Firestore
1. Firestore Database → Create database
2. Choose **production mode** (rules are in `firestore.rules`)
3. Deploy rules:
   ```bash
   npm install -g firebase-tools
   firebase login
   firebase deploy --only firestore:rules
   ```

---

### 3 — Deploy

#### Option A: Vercel (recommended)

```bash
npm install -g vercel
vercel --prod
```

Or push to GitHub and connect at [vercel.com](https://vercel.com).

#### Option B: Firebase Hosting

```bash
npm install -g firebase-tools
firebase login
firebase init hosting
firebase deploy
```

#### Option C: Local Testing (no server needed for static files)

Use VS Code **Live Server** extension or:
```bash
npx serve .
```
Open `http://localhost:3000/login.html`

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `→` / `Page Down` | Next page |
| `←` / `Page Up` | Previous page |
| `Home` | First page |
| `End` | Last page |
| `Ctrl +` | Zoom in |
| `Ctrl -` | Zoom out |
| `H` | Toggle highlight mode |
| `E` | Toggle erase mode |
| `B` | Toggle bookmark |
| `Ctrl+F` | Open search panel |
| `Esc` | Exit current mode |

---

## File Structure

```
COURSES-GLANCE/
│
├── login.html          ← Entry point / login screen
├── dashboard.html      ← Course library
├── viewer.html         ← PDF reader + highlights
│
├── css/
│   └── style.css       ← All styles (CSS variables, dark mode)
│
├── js/
│   ├── firebase.js     ← Firebase init, auth, Firestore CRUD
│   ├── viewer.js       ← PDF.js rendering, zoom, navigation
│   └── highlight.js    ← Highlight manager (add, draw, erase)
│
├── pdfs/               ← Your 18 PDF files go here
│
├── vercel.json         ← Vercel deployment config
├── firebase.json       ← Firebase Hosting config
└── firestore.rules     ← Firestore security rules
```

---

## Firestore Data Structure

```
highlights/             (collection)
  {autoId}              (document)
    userId:       string   ← Firebase auth uid
    pdfName:      string   ← e.g. "CHE110"
    page:         number   ← 1-based page index
    rects:        array    ← [{x,y,w,h}] as 0-1 fractions of page
    color:        string   ← "yellow" | "green" | "blue" | "pink" | "orange"
    selectedText: string   ← the highlighted text (reference)
    timestamp:    timestamp

userMeta/
  {userId}/
    pdfs/
      {pdfName}           ← last page + scale per PDF
    bookmarks/
      {pdfName_page}      ← bookmarked pages
```

---

## Security

- Every page checks Firebase Auth on load — unauthenticated users are redirected to `login.html`
- Firestore rules enforce that users can only read/write their **own** data
- No backend server required — all security is handled by Firebase

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| PDF doesn't load | Check file is in `pdfs/` with exact filename matching `COURSES` array |
| Login fails | Ensure the user exists in Firebase Auth console |
| Highlights don't save | Check Firestore is in test/production mode, rules deployed |
| CORS error on PDF | Host on Vercel/Firebase instead of file:// |

---

*Built with PDF.js + Firebase — no backend required.*