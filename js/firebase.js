/**
 * js/firebase.js
 * Firebase initialization, authentication helpers, and Firestore
 * highlight / bookmark CRUD operations.
 */

// ── Firebase SDK (modular v10 via CDN) ──────────────────────
import { initializeApp }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";

import {
    getAuth,
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
    getFirestore,
    collection,
    doc,
    addDoc,
    setDoc,
    getDoc,
    getDocs,
    deleteDoc,
    query,
    where,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ── Firebase Configuration ───────────────────────────────────
const firebaseConfig = {
    apiKey: "AIzaSyDsnJ91dyIa-HcTwrR7bPe1lEjLqJiycY4",
    authDomain: "courses-glance-a3388.firebaseapp.com",
    projectId: "courses-glance-a3388",
    storageBucket: "courses-glance-a3388.firebasestorage.app",
    messagingSenderId: "126518173027",
    appId: "1:126518173027:web:b5500967f0fb0a424c0756"
};

// ── Initialize ───────────────────────────────────────────────
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { auth, db };

// ╔═══════════════════════════════════════════════════════════╗
// ║  AUTH HELPERS                                             ║
// ╚═══════════════════════════════════════════════════════════╝

/**
 * Sign in with email + password.
 * Throws on failure — caller handles the error.
 */
export async function loginUser(email, password) {
    return signInWithEmailAndPassword(auth, email, password);
}

/** Sign out the current user. */
export async function logoutUser() {
    return signOut(auth);
}

/**
 * Subscribe to auth state changes.
 * @param {(user: import('firebase/auth').User|null) => void} callback
 */
export function onAuthChange(callback) {
    return onAuthStateChanged(auth, callback);
}

/**
 * Get the currently signed-in user (synchronous snapshot).
 * Returns null if not authenticated.
 */
export function getCurrentUser() {
    return auth.currentUser;
}

/**
 * Route guard — call on every protected page.
 * If no user is logged in, redirect to login.html immediately.
 * Returns a Promise that resolves with the user once confirmed.
 */
export function requireAuth() {
    return new Promise((resolve) => {
        const unsub = onAuthStateChanged(auth, (user) => {
            unsub();                               // unsubscribe after first emission
            if (!user) {
                window.location.replace("login.html");
            } else {
                resolve(user);
            }
        });
    });
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  HIGHLIGHT CRUD                                           ║
// ║                                                           ║
// ║  Firestore path:                                          ║
// ║    highlights/{userId}_{pdfName}_{page} — collection doc ║
// ║                                                           ║
// ║  Simpler flat collection:                                 ║
// ║    highlights/  (collection)                              ║
// ║      {autoId}   (document)                                ║
// ║        userId, pdfName, page, rects, color,               ║
// ║        selectedText, timestamp                            ║
// ╚═══════════════════════════════════════════════════════════╝

const HIGHLIGHTS_COL = "highlights";

/**
 * Save a new highlight to Firestore.
 *
 * @param {object} data
 * @param {string}   data.userId       - Auth uid
 * @param {string}   data.pdfName      - e.g. "CHE110"
 * @param {number}   data.page         - 1-based page number
 * @param {Array}    data.rects        - [{x,y,w,h}] as fractions of page (0-1)
 * @param {string}   data.color        - CSS color string
 * @param {string}   data.selectedText - The highlighted text (for reference)
 * @returns {Promise<string>} The new document ID
 */
export async function saveHighlight(data) {
    const docRef = await addDoc(collection(db, HIGHLIGHTS_COL), {
        userId: data.userId,
        pdfName: data.pdfName,
        page: data.page,
        rects: data.rects,
        color: data.color,
        selectedText: data.selectedText || "",
        timestamp: serverTimestamp()
    });
    return docRef.id;
}

/**
 * Load all highlights for a specific user + PDF.
 *
 * @param {string} userId
 * @param {string} pdfName
 * @returns {Promise<Array>} Array of highlight objects (with .id)
 */
export async function loadHighlights(userId, pdfName) {
    const q = query(
        collection(db, HIGHLIGHTS_COL),
        where("userId", "==", userId),
        where("pdfName", "==", pdfName)
    );

    const snapshot = await getDocs(q);
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Delete a highlight by its Firestore document ID.
 *
 * @param {string} highlightId
 */
export async function deleteHighlight(highlightId) {
    await deleteDoc(doc(db, HIGHLIGHTS_COL, highlightId));
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  LAST-PAGE / BOOKMARK PERSISTENCE                         ║
// ║                                                           ║
// ║  Stored in:  userMeta/{userId}/pdfs/{pdfName}             ║
// ╚═══════════════════════════════════════════════════════════╝

const USER_META_COL = "userMeta";

/**
 * Persist the last-viewed page and zoom for a PDF.
 *
 * @param {string} userId
 * @param {string} pdfName
 * @param {number} page
 * @param {number} scale
 */
export async function saveLastPage(userId, pdfName, page, scale) {
    const ref = doc(db, USER_META_COL, userId, "pdfs", pdfName);
    await setDoc(ref, { lastPage: page, lastScale: scale, updatedAt: serverTimestamp() }, { merge: true });
}

/**
 * Load last-viewed page and zoom for a PDF.
 * Returns { lastPage: 1, lastScale: 1.25 } or defaults.
 *
 * @param {string} userId
 * @param {string} pdfName
 */
export async function loadLastPage(userId, pdfName) {
    const ref = doc(db, USER_META_COL, userId, "pdfs", pdfName);
    const snap = await getDoc(ref);
    if (snap.exists()) return snap.data();
    return { lastPage: 1, lastScale: 1.25 };
}

/**
 * Save / clear a bookmark for a page.
 * Bookmarks stored under userMeta/{userId}/bookmarks/{pdfName_page}
 *
 * @param {string}  userId
 * @param {string}  pdfName
 * @param {number}  page
 * @param {boolean} bookmarked
 */
export async function setBookmark(userId, pdfName, page, bookmarked) {
    const key = `${pdfName}_${page}`;
    const ref = doc(db, USER_META_COL, userId, "bookmarks", key);
    if (bookmarked) {
        await setDoc(ref, { pdfName, page, createdAt: serverTimestamp() });
    } else {
        await deleteDoc(ref);
    }
}

/**
 * Load all bookmarks for a user + PDF.
 * Returns an array of page numbers.
 *
 * @param {string} userId
 * @param {string} pdfName
 * @returns {Promise<number[]>}
 */
export async function loadBookmarks(userId, pdfName) {
    const q = query(
        collection(db, USER_META_COL, userId, "bookmarks"),
        where("pdfName", "==", pdfName)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => d.data().page);
}

/**
 * Get aggregate highlight counts for all PDFs of a user.
 * Used by the dashboard to show badges.
 *
 * @param {string} userId
 * @returns {Promise<Record<string, number>>} { pdfName: count, ... }
 */
export async function getHighlightCounts(userId) {
    const q = query(collection(db, HIGHLIGHTS_COL), where("userId", "==", userId));
    const snap = await getDocs(q);
    const counts = {};
    snap.docs.forEach(d => {
        const name = d.data().pdfName;
        counts[name] = (counts[name] || 0) + 1;
    });
    return counts;
}