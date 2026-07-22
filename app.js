
  <script>
  atOptions = {
    'key' : '555edb5d94e4631de5bb7b83bc1a2968',
    'format' : 'iframe',
    'height' : 50,
    'width' : 320,
    'params' : {}
  };
</script>
<script src="https://www.highperformanceformat.com/555edb5d94e4631de5bb7b83bc1a2968/invoke.js"></script>


// ==========================================================================
// D-FLIX front-end logic
// Talks to the native Android bridge exposed as window.Android
// (isLoggedIn, login, listFiles, searchFiles, resolvePoster, openFile,
//  downloadFile, downloadFolder)
//
// VIEW MODES:
//   'home'      -> Netflix-style rows: every top-level folder (Marvel, Anime &
//                  Animation, ...) is a row, and whatever folders/files are
//                  inside that folder show up as cards in that same row.
//   'browse'    -> Old grid-drilldown view (entering any folder shows
//                  everything in the same 3-column grid as it used to
//                  look before).
//   'downloads' -> Downloads tab: shows the list of anything that was
//                  tapped to download.
//
// CARD CLICK BEHAVIOUR:
//   Tapping any card (file or folder) opens an action-sheet popup:
//     - If it's a file:   "Play" (stream instantly) or "Download" (save to device)
//     - If it's a folder: "View" (open it) or "Download" (download all
//                       files inside the folder)
//   Pressing Download moves that item into the Downloads tab.
// ==========================================================================

var LOCKED_ROOT_FOLDER_ID = "17s88x00QQXAnTQtFWasBIOcgRqziTEnQ";

// ==========================================================================
// CUSTOM POSTERS (set from admin.html into Firebase Realtime Database)
// The admin panel saves a poster URL against a folder/file's exact name;
// the app fetches all of them at once here and caches them, and checks
// this BEFORE requesting a poster from TMDB - if the admin has set a
// custom poster, that one is used instead.
// ==========================================================================

var FIREBASE_DB_URL = "https://dflix-7b2d2-default-rtdb.firebaseio.com";
var customPosterMap = {}; // encodedKey(name) -> image URL

// Firebase Realtime Database keys don't allow ". # $ [ ] /", but dots
// are common in file/folder names (like "Movie.2023.1080p.mkv") - so we
// convert those characters into a safe, reversible-style encoding.
// admin.html has the exact same function, so the key always matches on
// both sides.
function posterKeyEncode(name) {
  var normalized = (name || "").trim().toLowerCase().replace(/\s+/g, " ");
  return normalized.replace(/[.#$\[\]\/]/g, function (ch) {
    return "_" + ch.charCodeAt(0) + "_";
  });
}

function loadCustomPosters() {
  fetch(FIREBASE_DB_URL + "/posters.json")
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      var map = {};
      if (data) {
        Object.keys(data).forEach(function (key) {
          var entry = data[key];
          if (entry && entry.url) map[key] = entry.url;
        });
      }
      customPosterMap = map;
    })
    .catch(function () {
      // Firebase unreachable / offline - just fall back to TMDB posters
    });
}

var viewMode = "home";
var currentDownloadFolderName = null; // which folder we're currently inside, in the downloads tab
var folderStack = [{ id: LOCKED_ROOT_FOLDER_ID, name: "My Drive" }];
var currentFolderId = LOCKED_ROOT_FOLDER_ID;
var searchTimer = null;

var homeRowsCache = null;   // { folders: [...], looseFiles: [...] } - root listing cache
var pendingHeroChecks = 0;

// The hero banner is now a carousel: it collects 5-6 trending items and
// crossfades from one to the next every HERO_ROTATE_MS.
var HERO_MAX_CANDIDATES = 6;
var HERO_ROTATE_MS = 5000;
var heroCandidates = [];   // [{ id, name, rowTitle, poster }]
var heroCandidateIndex = 0;
var heroActiveLayer = 0;   // which bg layer (0/1) is currently visible
var heroRotateTimer = null;

// ---------- Elements ----------
var loginScreen = document.getElementById("loginScreen");
var loginBtn = document.getElementById("loginBtn");
var loginStatus = document.getElementById("loginStatus");
var appRoot = document.getElementById("app");
var breadcrumbEl = document.getElementById("breadcrumb");
var contentEl = document.getElementById("content");
var homeViewEl = document.getElementById("homeView");
var rowsContainerEl = document.getElementById("rowsContainer");
var heroSectionEl = document.getElementById("heroSection");
var heroTagEl = document.getElementById("heroTag");
var heroPlayBtn = document.getElementById("heroPlayBtn");
var heroBg0El = document.getElementById("heroBg0");
var heroBg1El = document.getElementById("heroBg1");
var heroDotsEl = document.getElementById("heroDots");

var searchOverlay = document.getElementById("searchOverlay");
var searchInput = document.getElementById("searchInput");
var searchBody = document.getElementById("searchBody");
var searchResultLabel = document.getElementById("searchResultLabel");
var btnClearSearch = document.getElementById("btnClearSearch");
var searchIdleState = document.getElementById("searchIdleState");

var navHome = document.getElementById("navHome");
var navMovies = document.getElementById("navMovies");
var navWebSeries = document.getElementById("navWebSeries");
var toastEl = document.getElementById("toast");

var actionSheetOverlay = document.getElementById("actionSheetOverlay");
var actionSheetTitle = document.getElementById("actionSheetTitle");
var actionSheetBody = document.getElementById("actionSheetBody");

var confirmOverlay = document.getElementById("confirmOverlay");
var confirmTitle = document.getElementById("confirmTitle");
var confirmMsg = document.getElementById("confirmMsg");
var confirmDeleteBtn = document.getElementById("confirmDeleteBtn");

var navDownloads = document.getElementById("navDownloads");
var downloadsViewEl = document.getElementById("downloadsView");
var downloadsListEl = document.getElementById("downloadsList");

var notifOverlay = document.getElementById("notifOverlay");
var notifListEl = document.getElementById("notifList");
var bellBadgeEl = document.getElementById("bellBadge");

var requestOverlay = document.getElementById("requestOverlay");
var requestNameInput = document.getElementById("requestNameInput");
var requestNoteInput = document.getElementById("requestNoteInput");
var btnSendRequest = document.getElementById("btnSendRequest");

// ==========================================================================
// TV REMOTE NAVIGATION (bottom nav bar)
// On the Android side, D-pad key events get sent into the WebView as
// normal keyboard KeyboardEvents (ArrowLeft/ArrowRight/Enter), as long as
// the WebView has Android focus - see MainActivity.java. Here we just
// listen for those keys to move the left/right cursor between bottom-nav
// items, and pressing "Enter"/OK opens whichever tab the cursor is on.
// ==========================================================================

var tvNavItems = [];     // all bottom-nav buttons, in left-to-right order
var tvNavIndex = 0;      // which index the remote "cursor" is currently on
var tvNavActive = false; // no highlight shows until the user presses the D-pad for the first time

function initTvNav() {
  tvNavItems = Array.prototype.slice.call(document.querySelectorAll(".bottom-nav .nav-item"));
}

function isTypingContext() {
  var el = document.activeElement;
  return !!(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA"));
}

function isOverlayOpen() {
  return searchOverlay.classList.contains("active")
    || confirmOverlay.classList.contains("active")
    || actionSheetOverlay.classList.contains("active")
    || notifOverlay.classList.contains("active")
    || requestOverlay.classList.contains("active");
}

function setTvNavFocus(index) {
  if (tvNavItems.length === 0) return;
  if (index < 0) index = 0;
  if (index > tvNavItems.length - 1) index = tvNavItems.length - 1;

  for (var i = 0; i < tvNavItems.length; i++) tvNavItems[i].classList.remove("focused");
  tvNavIndex = index;
  var el = tvNavItems[tvNavIndex];
  el.classList.add("focused");
  try { el.focus(); } catch (e) { /* focus() can fail on some WebView versions - that's fine */ }
  tvNavActive = true;
}

function moveTvNavFocus(delta) {
  if (!tvNavActive) {
    // The first time the D-pad is pressed, start the cursor on whichever tab is currently active
    var activeIdx = 0;
    for (var i = 0; i < tvNavItems.length; i++) {
      if (tvNavItems[i].classList.contains("active")) { activeIdx = i; break; }
    }
    setTvNavFocus(activeIdx);
    return;
  }
  setTvNavFocus(tvNavIndex + delta);
}

function activateTvNavFocus() {
  if (!tvNavActive || !tvNavItems[tvNavIndex]) return;
  tvNavItems[tvNavIndex].click();
}

// If a nav item is tapped with touch/mouse, sync the remote-cursor to
// that same item, so the next D-pad press continues from there.
function syncTvNavToClickedItem(el) {
  var idx = tvNavItems.indexOf(el);
  if (idx !== -1) {
    tvNavIndex = idx;
    tvNavActive = true;
    for (var i = 0; i < tvNavItems.length; i++) tvNavItems[i].classList.remove("focused");
    el.classList.add("focused");
  }
}

document.addEventListener("keydown", function (e) {
  if (isTypingContext() || isOverlayOpen()) return;

  if (e.key === "ArrowLeft") {
    moveTvNavFocus(-1);
    e.preventDefault();
  } else if (e.key === "ArrowRight") {
    moveTvNavFocus(1);
    e.preventDefault();
  } else if (e.key === "Enter") {
    if (tvNavActive) {
      activateTvNavFocus();
      e.preventDefault();
    }
  }
});

document.addEventListener("click", function (e) {
  var navBtn = e.target.closest ? e.target.closest(".bottom-nav .nav-item") : null;
  if (navBtn) syncTvNavToClickedItem(navBtn);
});

// ---------- Init ----------
window.addEventListener("load", function () {
  checkLogin();
  loadCustomPosters();
  initTvNav();
  refreshBellBadge();
});

document.addEventListener("visibilitychange", function () {
  if (!document.hidden && loginScreen && !loginScreen.classList.contains("hidden")) {
    checkLogin();
  }
  if (!document.hidden) {
    refreshBellBadge();
  }
});

function checkLogin() {
  var isLoggedIn = false;
  try {
    isLoggedIn = Android.isLoggedIn();
  } catch (e) {
    isLoggedIn = false;
  }

  if (isLoggedIn) {
    showMain();
  } else {
    showLogin();
  }
}

function showLogin() {
  loginScreen.classList.remove("hidden");
  appRoot.classList.add("hidden");
}

function showMain() {
  loginScreen.classList.add("hidden");
  appRoot.classList.remove("hidden");
  goHome(false);
}

// ---------- Login ----------
loginBtn.addEventListener("click", function () {
  loginStatus.textContent = "Opening Google login...";
  Android.login();
});

function onLoginComplete(success) {
  if (success) {
    loginStatus.textContent = "";
    showMain();
  } else {
    loginStatus.textContent = "Login failed, please try again.";
  }
}

// ---------- Bottom nav ----------
function goHome(force) {
  closeSearch();
  viewMode = "home";
  folderStack = [{ id: LOCKED_ROOT_FOLDER_ID, name: "My Drive" }];
  appRoot.classList.remove("browse-mode");
  setActiveNav(navHome);
  homeViewEl.classList.remove("hidden");
  contentEl.classList.add("hidden");
  downloadsViewEl.classList.add("hidden");
  loadHomeRows(!!force);
}

// ==========================================================================
// MOVIE / WEB SERIES TABS
// "Movie" tab = content of the root's "Bollywood" + "Hollywood" folders
// combined. "Web Series" tab = content of the root's "Web Series"
// folder. Names are matched case-insensitively.
// ==========================================================================

var tempCbSeq = 0;
function registerTempCallback(fn) {
  tempCbSeq++;
  var name = "onTempCb_" + tempCbSeq;
  window[name] = function (data) {
    delete window[name];
    fn(data);
  };
  return name;
}

// Use the cached root folder listing if it's already available, otherwise fetch it
function ensureRootFoldersLoaded(callback, forceRefresh) {
  if (!forceRefresh && homeRowsCache && homeRowsCache.folders) {
    callback(homeRowsCache.folders);
    return;
  }
  var cbName = registerTempCallback(function (data) {
    if (data && data.error) {
      if (data.error === "not_logged_in") { showLogin(); return; }
      callback([]);
      return;
    }
    var files = (data && data.files) ? data.files : [];
    var folders = [];
    var looseFiles = [];
    for (var i = 0; i < files.length; i++) {
      if (files[i].mimeType === "application/vnd.google-apps.folder") folders.push(files[i]);
      else looseFiles.push(files[i]);
    }
    homeRowsCache = { folders: folders, looseFiles: looseFiles };
    callback(folders);
  });
  Android.listFiles(LOCKED_ROOT_FOLDER_ID, cbName);
}

// The Movie tab also includes files from these "nested paths" besides
// Bollywood/Hollywood - each entry is a sequence of folder names from the
// root going inward. Adding a new path here makes it easy to pull in
// files from any deeply nested folder into the Movie tab.
var MOVIE_TAB_EXTRA_PATHS = [
  ["Marvel", "Avengers", "480p"],
  ["Harry Potter", "480p"],
  ["Pirates of the Caribbean", "480p"],
  ["Transformer", "480p"],
  ["DC", "480p"],
  ["Marvel", "X-Men"]
];

function goMovies() {
  closeSearch();
  viewMode = "movies";
  appRoot.classList.remove("browse-mode");
  setActiveNav(navMovies);
  homeViewEl.classList.add("hidden");
  downloadsViewEl.classList.add("hidden");
  contentEl.classList.remove("hidden");
  loadCategoryFolders(["Bollywood", "Hollywood", "Fast and Furious", "Mission Impossible",], "Movie", true, MOVIE_TAB_EXTRA_PATHS);
}

function goWebSeries() {
  closeSearch();
  viewMode = "webseries";
  appRoot.classList.remove("browse-mode");
  setActiveNav(navWebSeries);
  homeViewEl.classList.add("hidden");
  downloadsViewEl.classList.add("hidden");
  contentEl.classList.remove("hidden");
  loadCategoryFolders(["Web Series"], "Web Series", false);
}

// When comparing folder names, ignore case, extra spaces, and punctuation
// (e.g. "Hollywood", "hollywood ", "Holly-Wood" will all match), so the
// category tab doesn't end up empty over a minor naming difference.
function normalizeFolderName(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Fisher-Yates shuffle - so Bollywood/Hollywood don't show in a fixed
// order (like they're already sorted in Drive), but in a mixed/random
// order each time.
function shuffleArray(arr) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

function loadCategoryFolders(folderNameList, label, shuffleResults, extraNestedPaths) {
  contentEl.innerHTML = '<div class="row-header" style="padding:16px 16px 6px;"><div class="row-title">'
    + escapeHtml(label) + '</div></div><div id="categoryGrid"></div>';
  var gridEl = document.getElementById("categoryGrid");
  showLoadingState(gridEl);

  var normalizedTargets = folderNameList.map(normalizeFolderName);

  ensureRootFoldersLoaded(function (rootFolders) {
    var matches = rootFolders.filter(function (f) {
      var normalizedName = normalizeFolderName(f.name);
      return normalizedTargets.some(function (n) {
        return normalizedName === n || normalizedName.indexOf(n) !== -1;
      });
    });

    var paths = extraNestedPaths || [];
    var totalTasks = matches.length + paths.length;

    if (totalTasks === 0) {
      showStateScreen(gridEl, "\uD83D\uDCED", "Nothing found",
        'No folder named "' + folderNameList.join(" / ") + '" was found in Drive.');
      return;
    }

    var combined = [];
    var remaining = totalTasks;

    function taskDone() {
      remaining--;
      if (remaining === 0) {
        if (combined.length === 0) {
          showStateScreen(gridEl, "\uD83D\uDCED", "Nothing found",
            'No folder named "' + folderNameList.join(" / ") + '" was found in Drive.');
          return;
        }
        renderGrid({ files: shuffleResults ? shuffleArray(combined) : combined }, gridEl, false);
      }
    }

    matches.forEach(function (folder) {
      var cbName = registerTempCallback(function (data) {
        var files = (data && data.files) ? data.files : [];
        combined = combined.concat(files);
        taskDone();
      });
      try {
        Android.listFiles(folder.id, cbName);
      } catch (e) {
        taskDone();
      }
    });

    paths.forEach(function (pathNames) {
      resolveNestedFolderFiles(rootFolders, pathNames, function (files) {
        combined = combined.concat(files);
        taskDone();
      });
    });
  }, true);
}

// Finds a folder by name inside the root (like "Marvel"), then the next
// name inside that (like "Avengers"), then the next (like "480p") - this
// way it reaches the last folder in the path and passes all its files to
// the callback. If a folder isn't found at any step, it passes an empty
// list (this doesn't affect the other category items).
function resolveNestedFolderFiles(rootFolders, pathNames, callback) {
  if (!pathNames || pathNames.length === 0) { callback([]); return; }

  var normalizedFirst = normalizeFolderName(pathNames[0]);
  var startFolder = null;
  for (var i = 0; i < rootFolders.length; i++) {
    var n = normalizeFolderName(rootFolders[i].name);
    if (n === normalizedFirst || n.indexOf(normalizedFirst) !== -1) {
      startFolder = rootFolders[i];
      break;
    }
  }
  if (!startFolder) { callback([]); return; }
  descendFolderPath(startFolder.id, pathNames.slice(1), callback);
}

function descendFolderPath(folderId, remainingNames, callback) {
  if (remainingNames.length === 0) {
    var cbName = registerTempCallback(function (data) {
      callback((data && data.files) ? data.files : []);
    });
    try {
      Android.listFiles(folderId, cbName);
    } catch (e) {
      callback([]);
    }
    return;
  }

  var targetName = normalizeFolderName(remainingNames[0]);
  var cbName = registerTempCallback(function (data) {
    var files = (data && data.files) ? data.files : [];
    var next = null;
    for (var i = 0; i < files.length; i++) {
      if (files[i].mimeType === "application/vnd.google-apps.folder") {
        var n = normalizeFolderName(files[i].name);
        if (n === targetName || n.indexOf(targetName) !== -1) {
          next = files[i];
          break;
        }
      }
    }
    if (!next) { callback([]); return; }
    descendFolderPath(next.id, remainingNames.slice(1), callback);
  });
  try {
    Android.listFiles(folderId, cbName);
  } catch (e) {
    callback([]);
  }
}

function comingSoon(label) {
  showToast(label + " is coming soon!");
}

// ==========================================================================
// NOTIFICATIONS (real-time, sent from the admin panel via Firebase ->
// FirebaseNotifyListener.java on the Android side). Two bridge calls are
// used: Android.getNotifications() (local history) and
// Android.markNotificationsRead() / Android.clearNotifications().
// A live one also arrives anytime via window.onPushNotification(...),
// called directly from FirebaseNotifyListener while the app is open.
// ==========================================================================

function refreshBellBadge() {
  var count = 0;
  try {
    var list = JSON.parse(Android.getNotifications() || "[]");
    list.forEach(function (n) { if (!n.read) count++; });
  } catch (e) { /* Android bridge not ready yet, or not on device */ }

  if (count > 0) {
    bellBadgeEl.textContent = count > 9 ? "9+" : String(count);
    bellBadgeEl.classList.remove("hidden");
  } else {
    bellBadgeEl.classList.add("hidden");
  }
}

function notifTimeAgo(ts) {
  var diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return "Just now";
  var diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return diffMin + "m ago";
  var diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return diffHr + "h ago";
  var diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return diffDay + "d ago";
  return new Date(ts).toLocaleDateString();
}

function renderNotifications() {
  var list = [];
  try {
    list = JSON.parse(Android.getNotifications() || "[]");
  } catch (e) { list = []; }

  if (list.length === 0) {
    notifListEl.innerHTML = '<div class="notif-empty"><div class="emoji">🔔</div>'
      + '<div>No notifications yet</div></div>';
    return;
  }

  var html = "";
  list.forEach(function (n) {
    var unreadClass = n.read ? "" : " unread";
    var iconHtml;
    if (n.poster) {
      iconHtml = '<div class="notif-icon has-poster"><img src="' + escapeHtml(n.poster) + '" alt=""></div>';
    } else {
      iconHtml = '<div class="notif-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></div>';
    }
    html += '<div class="notif-item' + unreadClass + '">'
      + iconHtml
      + '<div class="notif-body-text">'
      + '<div class="notif-item-title">' + escapeHtml(n.title || "D-FLIX") + '</div>'
      + '<div class="notif-item-msg">' + escapeHtml(n.body || "") + '</div>'
      + '<div class="notif-item-time">' + notifTimeAgo(n.ts) + '</div>'
      + '</div></div>';
  });
  notifListEl.innerHTML = html;
}

function escapeHtml(str) {
  var div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function openNotifications() {
  renderNotifications();
  notifOverlay.classList.add("active");
  try { Android.markNotificationsRead(); } catch (e) { }
  refreshBellBadge();
}

function closeNotifications() {
  notifOverlay.classList.remove("active");
}

function clearAllNotifications() {
  try { Android.clearNotifications(); } catch (e) { }
  renderNotifications();
  refreshBellBadge();
}

/** Called directly from FirebaseNotifyListener.java (MainActivity.pushToWeb)
 *  whenever a new notification arrives while the app is open. */
function onPushNotification(jsonStr) {
  try {
    var n = JSON.parse(jsonStr);
    showToast((n.title || "D-FLIX") + ": " + (n.body || ""));
  } catch (e) { }
  refreshBellBadge();
  if (notifOverlay.classList.contains("active")) {
    renderNotifications();
    try { Android.markNotificationsRead(); } catch (e2) { }
  }
}

/** Called directly from FirebaseNotifyListener.java (MainActivity.removeFromWeb)
 *  whenever a notification is deleted from the admin panel. */
function onNotificationRemoved(id) {
  refreshBellBadge();
  if (notifOverlay.classList.contains("active")) {
    renderNotifications();
  }
}

// ==========================================================================
// MOVIE / SERIES REQUEST (Profile tab). Saved into the same Firebase
// Realtime Database already used for posters/notifications, under
// "/requests/{pushId}" - the standalone admin_requests.html panel reads
// and manages this list.
// ==========================================================================

function openRequestPanel() {
  requestOverlay.classList.add("active");
  setTimeout(function () { try { requestNameInput.focus(); } catch (e) { } }, 200);
}

function closeRequestPanel() {
  requestOverlay.classList.remove("active");
}

function sendMovieRequest() {
  var name = (requestNameInput.value || "").trim();
  var note = (requestNoteInput.value || "").trim();

  if (!name) {
    showToast("Please enter a movie or series name");
    try { requestNameInput.focus(); } catch (e) { }
    return;
  }

  btnSendRequest.disabled = true;
  btnSendRequest.textContent = "Sending...";

  var payload = { name: name, note: note, ts: Date.now() };

  function resetSendBtn() {
    btnSendRequest.disabled = false;
    btnSendRequest.textContent = "Send Request";
  }

  fetch(FIREBASE_DB_URL + "/requests.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  })
    .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error("Request failed")); })
    .then(function () {
      showToast("Request sent! We'll try to add it soon.");
      requestNameInput.value = "";
      requestNoteInput.value = "";
      closeRequestPanel();
      resetSendBtn();
    })
    .catch(function () {
      showToast("Couldn't send request - check your internet connection.");
      resetSendBtn();
    });
}

function setActiveNav(el) {
  var items = document.querySelectorAll(".nav-item");
  items.forEach(function (n) { n.classList.remove("active"); });
  if (el) el.classList.add("active");
}

// ---------- Hardware/gesture back button (called from MainActivity.java) ----------
function handleBackPress() {
  if (searchOverlay.classList.contains("active")) {
    closeSearch();
    return true;
  }
  if (confirmOverlay.classList.contains("active")) {
    closeConfirm();
    return true;
  }
  if (actionSheetOverlay.classList.contains("active")) {
    closeActionSheet();
    return true;
  }
  if (notifOverlay.classList.contains("active")) {
    closeNotifications();
    return true;
  }
  if (requestOverlay.classList.contains("active")) {
    closeRequestPanel();
    return true;
  }
  if (viewMode === "downloads" || viewMode === "movies" || viewMode === "webseries") {
    goHome(false);
    return true;
  }
  if (viewMode === "downloadFolder") {
    exitDownloadFolderLevel();
    return true;
  }
  if (viewMode === "browse" && folderStack.length > 1) {
    goBackFolder();
    return true;
  }
  return false;
}

// Both the visible back-chevron in the header (in browse-mode) and hardware-back use this
function goBackFolder() {
  if (viewMode === "downloadFolder") {
    exitDownloadFolderLevel();
    return;
  }
  if (folderStack.length <= 1) return;
  folderStack.pop();
  var top = folderStack[folderStack.length - 1];
  if (folderStack.length === 1) {
    goHome(false);
  } else {
    loadFolder(top.id, top.name);
  }
}

// ---------- Breadcrumb (disabled) ----------
function renderBreadcrumb() {
  breadcrumbEl.classList.add("hidden");
  breadcrumbEl.innerHTML = "";
}

// ==========================================================================
// HOME VIEW (Netflix-style rows)
// ==========================================================================

function loadHomeRows(force) {
  if (homeRowsCache && !force) {
    renderHomeFromCache();
    return;
  }
  resetHeroState();
  rowsContainerEl.innerHTML =
    '<div class="row-section"><div class="row-header"><div class="row-title">Loading...</div></div>' +
    '<div class="row-loading"><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div></div></div>';
  Android.listFiles(LOCKED_ROOT_FOLDER_ID, "onHomeRootLoaded");
}

function onHomeRootLoaded(data) {
  if (data && data.error) {
    if (data.error === "not_logged_in") { showLogin(); return; }
    rowsContainerEl.innerHTML = "";
    showStateScreen(rowsContainerEl, "\u26A0\uFE0F", "Something went wrong", escapeHtml(data.error));
    return;
  }

  var files = (data && data.files) ? data.files : [];
  var folders = [];
  var looseFiles = [];

  for (var i = 0; i < files.length; i++) {
    if (files[i].mimeType === "application/vnd.google-apps.folder") {
      folders.push(files[i]);
    } else {
      looseFiles.push(files[i]);
    }
  }

  homeRowsCache = { folders: folders, looseFiles: looseFiles };
  renderHomeFromCache();
}

function renderHomeFromCache() {
  var folders = homeRowsCache.folders;
  var looseFiles = homeRowsCache.looseFiles;

  if (folders.length === 0 && looseFiles.length === 0) {
    rowsContainerEl.innerHTML = "";
    showStateScreen(rowsContainerEl, "\uD83D\uDCED", "Nothing found", "This Drive folder is empty.");
    return;
  }

  rowsContainerEl.innerHTML = "";
  pendingHeroChecks = folders.length + (looseFiles.length > 0 ? 1 : 0);

  folders.forEach(function (folder, idx) {
    var rowId = "row" + idx + "_" + Date.now();
    rowsContainerEl.appendChild(buildRowSkeleton(rowId, folder.name, folder));
    fetchRowChildren(rowId, folder);
  });

  if (looseFiles.length > 0) {
    var rowId = "rowLoose_" + Date.now();
    rowsContainerEl.appendChild(buildRowSkeleton(rowId, "Files", null));
    renderRow(rowId, looseFiles);
    setHeroFromFiles(looseFiles, "Files");
    checkHeroFallback();
  }
}

function buildRowSkeleton(rowId, title, folder) {
  var section = document.createElement("div");
  section.className = "row-section";
  section.id = "section_" + rowId;

  var seeAllBtn = folder
    ? '<button class="row-seeall" data-see-all-id="' + folder.id + '" data-see-all-name="' + escapeHtml(folder.name) + '">See All</button>'
    : "";

  section.innerHTML =
    '<div class="row-header"><div class="row-title">' + escapeHtml(title) + '</div>' + seeAllBtn + '</div>' +
    '<div class="row-loading" id="loading_' + rowId + '"><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div></div>' +
    '<div class="movie-row hidden" id="row_' + rowId + '"></div>';

  if (folder) {
    var btn = section.querySelector("[data-see-all-id]");
    btn.addEventListener("click", function () {
      enterBrowseFolder(folder.id, folder.name);
    });
  }
  return section;
}

function fetchRowChildren(rowId, folder) {
  var cbName = "onRowLoaded_" + rowId;
  window[cbName] = function (data) {
    delete window[cbName];
    var files = (data && data.files) ? data.files : [];
    renderRow(rowId, files, folder.name);
    if (files.length > 0) setHeroFromFiles(files, folder.name);
    checkHeroFallback();
  };
  try {
    Android.listFiles(folder.id, cbName);
  } catch (e) {
    renderRow(rowId, []);
    checkHeroFallback();
  }
}

function renderRow(rowId, files) {
  var loadingEl = document.getElementById("loading_" + rowId);
  var rowEl = document.getElementById("row_" + rowId);
  if (!rowEl) return;

  if (loadingEl) loadingEl.remove();

  if (files.length === 0) {
    var section = document.getElementById("section_" + rowId);
    if (section) section.remove();
    return;
  }

  var html = "";
  files.forEach(function (f) {
    html += buildCardHtml(f);
  });
  rowEl.innerHTML = html;
  rowEl.classList.remove("hidden");

  attachCardHandlers(rowEl, false);
  lazyLoadPostersIn(rowEl);
}

// Picks one trending video file from each row and collects candidates up
// to HERO_MAX_CANDIDATES - the hero banner rotates between these.
function setHeroFromFiles(files, rowTitle) {
  if (heroCandidates.length >= HERO_MAX_CANDIDATES) return;
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    if (f.mimeType !== "application/vnd.google-apps.folder" && isVideoFile(f.name)) {
      heroCandidates.push({ id: f.id, name: f.name, rowTitle: rowTitle, poster: null });
      if (heroCandidates.length >= HERO_MAX_CANDIDATES) return;
    }
  }
}

// All the home rows have finished loading - if at least one trending
// candidate was found, start the carousel, otherwise show "Coming Soon".
function checkHeroFallback() {
  pendingHeroChecks--;
  if (pendingHeroChecks <= 0) {
    if (heroCandidates.length > 0) {
      startHeroCarousel();
    } else {
      setHeroComingSoon();
    }
  }
}

function resetHeroState() {
  heroCandidates = [];
  heroCandidateIndex = 0;
  heroActiveLayer = 0;
  if (heroRotateTimer) {
    clearInterval(heroRotateTimer);
    heroRotateTimer = null;
  }
  [heroBg0El, heroBg1El].forEach(function (el) {
    if (el) { el.classList.remove("active"); el.style.backgroundImage = ""; }
  });
  if (heroDotsEl) heroDotsEl.innerHTML = "";
}

function startHeroCarousel() {
  if (heroRotateTimer) { clearInterval(heroRotateTimer); heroRotateTimer = null; }
  renderHeroDots();
  showHeroCandidate(0);
  if (heroCandidates.length > 1) {
    heroRotateTimer = setInterval(function () {
      var nextIdx = (heroCandidateIndex + 1) % heroCandidates.length;
      showHeroCandidate(nextIdx);
    }, HERO_ROTATE_MS);
  }
}

function renderHeroDots() {
  if (!heroDotsEl) return;
  if (heroCandidates.length <= 1) { heroDotsEl.innerHTML = ""; return; }
  var html = "";
  for (var i = 0; i < heroCandidates.length; i++) {
    html += '<div class="dot' + (i === 0 ? " active" : "") + '"></div>';
  }
  heroDotsEl.innerHTML = html;
}

function showHeroCandidate(idx) {
  var c = heroCandidates[idx];
  if (!c) return;
  heroCandidateIndex = idx;

  heroTagEl.textContent = "TRENDING IN " + c.rowTitle.toUpperCase();
  heroPlayBtn.onclick = function () { Android.openFile(c.id, c.name); };

  if (c.poster) {
    applyHeroBackground(c.poster);
  } else {
    requestHeroPoster(c.name, idx);
  }

  if (heroDotsEl) {
    var dots = heroDotsEl.querySelectorAll(".dot");
    dots.forEach(function (d, i) { d.classList.toggle("active", i === idx); });
  }
}

function applyHeroBackground(url) {
  var showEl = heroActiveLayer === 0 ? heroBg1El : heroBg0El;
  var hideEl = heroActiveLayer === 0 ? heroBg0El : heroBg1El;
  if (!showEl || !hideEl) return;
  showEl.style.backgroundImage = url ? "url('" + url + "')" : "";
  showEl.classList.add("active");
  hideEl.classList.remove("active");
  heroActiveLayer = heroActiveLayer === 0 ? 1 : 0;
}

function setHeroComingSoon() {
  heroTagEl.textContent = "COMING SOON";
  applyHeroBackground(null);
  heroPlayBtn.onclick = function () { showToast("Coming soon!"); };
}

function requestHeroPoster(fileName, idx) {
  var customUrl = customPosterMap[posterKeyEncode(fileName)];
  if (customUrl) {
    heroCandidates[idx].poster = customUrl;
    if (idx === heroCandidateIndex) applyHeroBackground(customUrl);
    return;
  }
  try {
    Android.resolveBackdrop(fileName, "heroReq_" + idx);
  } catch (e) {
    // Older APK build without resolveBackdrop - fall back to the poster
    try { Android.resolvePoster(fileName, "heroReq_" + idx); } catch (e2) { /* ignore */ }
  }
}

// ==========================================================================
// BROWSE VIEW (old grid drilldown - after entering a folder)
// ==========================================================================

function enterBrowseFolder(id, name) {
  viewMode = "browse";
  appRoot.classList.add("browse-mode");
  folderStack.push({ id: id, name: name });
  homeViewEl.classList.add("hidden");
  contentEl.classList.remove("hidden");
  loadFolder(id, name);
}

function loadFolder(folderId, folderName) {
  currentFolderId = folderId;
  renderBreadcrumb();
  showLoadingState(contentEl);
  Android.listFiles(folderId, "onFilesLoaded");
}

function onFilesLoaded(data) {
  renderGrid(data, contentEl, false);
}

// ---------- Search ----------
function openSearch() {
  searchOverlay.classList.add("active");
  setTimeout(function () { searchInput.focus(); }, 150);
}

function closeSearch() {
  searchOverlay.classList.remove("active");
  searchInput.value = "";
  btnClearSearch.style.display = "none";
  searchResultLabel.classList.add("hidden");
  searchBody.innerHTML = "";
  searchBody.appendChild(searchIdleState);
}

function clearSearch() {
  searchInput.value = "";
  btnClearSearch.style.display = "none";
  searchResultLabel.classList.add("hidden");
  searchBody.innerHTML = "";
  searchBody.appendChild(searchIdleState);
  searchInput.focus();
}

var searchRequestSeq = 0;

searchInput.addEventListener("input", function () {
  var keyword = searchInput.value.trim();
  btnClearSearch.style.display = keyword.length ? "flex" : "none";
  clearTimeout(searchTimer);

  if (keyword.length === 0) {
    searchResultLabel.classList.add("hidden");
    searchBody.innerHTML = "";
    searchBody.appendChild(searchIdleState);
    return;
  }

  searchTimer = setTimeout(function () {
    showLoadingState(searchBody);
    searchRequestSeq++;
    var mySeq = searchRequestSeq;
    var cbName = "onSearchResults_" + mySeq;

    // Per-request callback: if the user kept typing and a newer search has
    // since been fired, this (now-stale) response is dropped instead of
    // flashing outdated results over the current keyword's results.
    window[cbName] = function (data) {
      delete window[cbName];
      if (mySeq !== searchRequestSeq) return;
      var keyword2 = searchInput.value.trim();
      searchResultLabel.classList.remove("hidden");
      searchResultLabel.textContent = 'Results for "' + keyword2 + '"';
      renderGrid(data, searchBody, true);
    };

    Android.searchFiles(keyword, cbName);
  }, 200);
});

// ==========================================================================
// SHARED CARD RENDERING (used by both the grid and the row)
// ==========================================================================

var posterUidSeq = 0;

function buildCardHtml(f) {
  var isFolder = f.mimeType === "application/vnd.google-apps.folder";
  var isVideo = !isFolder && isVideoFile(f.name);
  posterUidSeq++;
  var uid = "poster_u" + posterUidSeq;

  var html = '<div class="grid-card' + (isFolder ? " folder-card" : "") + '" '
    + 'data-id="' + f.id + '" data-name="' + escapeHtml(f.name) + '" data-folder="' + isFolder + '" '
    + 'tabindex="0">';

  if (isVideo) {
    html += '<div class="no-poster" id="' + uid + '" data-poster-query="' + escapeHtml(f.name) + '"><div class="gi">\uD83C\uDFAC</div></div>';
    html += '<span class="badge">HD</span>';
  } else if (isFolder) {
    html += '<div class="no-poster" id="' + uid + '" data-poster-query="' + escapeHtml(f.name) + '"><div class="gi">\uD83D\uDCC1</div></div>';
  } else {
    html += '<div class="no-poster"><div class="gi">' + getFileIcon(f.name) + '</div></div>';
  }

  html += '<div class="grid-name">' + escapeHtml(f.name) + '</div>';
  html += '</div>';
  return html;
}

function attachCardHandlers(container, isSearchContext) {
  var items = container.querySelectorAll(".grid-card");
  items.forEach(function (item) {
    item.addEventListener("click", function () {
      var id = item.getAttribute("data-id");
      var name = item.getAttribute("data-name");
      var isFolder = item.getAttribute("data-folder") === "true";

      if (isSearchContext) closeSearch();
      openActionSheet(id, name, isFolder);
    });
  });
}

// ---------- Render (classic 3-column grid - used by both browse-mode and search) ----------
function renderGrid(data, container, isSearch) {
  if (data && data.error) {
    if (data.error === "not_logged_in") {
      showLogin();
      return;
    }
    showStateScreen(container, "\u26A0\uFE0F", "Something went wrong", escapeHtml(data.error));
    showToast("Error: " + data.error);
    return;
  }

  var files = (data && data.files) ? data.files : [];

  if (files.length === 0) {
    showStateScreen(container, "\uD83D\uDCED", "Nothing found",
      isSearch ? "No file found with this name." : "This folder is empty.");
    return;
  }

  var html = '<div class="movie-grid">';
  for (var i = 0; i < files.length; i++) {
    html += buildCardHtml(files[i]);
  }
  html += '</div>';
  container.innerHTML = html;

  attachCardHandlers(container, isSearch);
  lazyLoadPostersIn(container);
}

// ---------- State screens ----------
function showLoadingState(container) {
  container.innerHTML = '<div class="state-screen"><div class="spinner"></div><div class="msg">Loading...</div></div>';
}

function showStateScreen(container, emoji, title, msg) {
  container.innerHTML = '<div class="state-screen">'
    + '<div class="emoji">' + emoji + '</div>'
    + '<div class="title">' + title + '</div>'
    + '<div class="msg">' + msg + '</div>'
    + '</div>';
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  setTimeout(function () { toastEl.classList.remove("show"); }, 2500);
}

// ==========================================================================
// TMDB POSTERS (lazy load) - now used for both folder-cards and video-cards
// ==========================================================================

function isVideoFile(name) {
  var lower = name.toLowerCase();
  return lower.endsWith(".mkv") || lower.endsWith(".mp4") || lower.endsWith(".avi") || lower.endsWith(".mov");
}

function lazyLoadPostersIn(container) {
  var targets = container.querySelectorAll("[data-poster-query]");
  if (!("IntersectionObserver" in window)) {
    targets.forEach(function (el) { requestPoster(el.getAttribute("data-poster-query"), el); });
    return;
  }
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        observer.unobserve(entry.target);
        requestPoster(entry.target.getAttribute("data-poster-query"), entry.target);
      }
    });
  }, { rootMargin: "200px" });
  targets.forEach(function (el) { observer.observe(el); });
}

var posterRequestSeq = 0;
var pendingPosterRequests = {};

function requestPoster(query, iconEl) {
  if (!query) return;
  var customUrl = customPosterMap[posterKeyEncode(query)];
  if (customUrl) {
    applyPosterImage(iconEl, customUrl);
    return;
  }
  try {
    posterRequestSeq++;
    var reqId = "p" + posterRequestSeq;
    pendingPosterRequests[reqId] = iconEl;
    Android.resolvePoster(query, reqId);
  } catch (e) {
    // Android.resolvePoster is not available (older build) - just leave the icon as is
  }
}

function applyPosterImage(iconEl, url) {
  var img = document.createElement("img");
  img.className = "thumb";
  img.src = url;
  iconEl.replaceWith(img);
}

function onPosterResolved(requestId, dataUrl) {
  if (requestId.indexOf("heroReq_") === 0) {
    var idx = parseInt(requestId.slice(8), 10);
    if (dataUrl && heroCandidates[idx]) {
      heroCandidates[idx].poster = dataUrl;
      if (idx === heroCandidateIndex) applyHeroBackground(dataUrl);
    }
    return;
  }
  var iconEl = pendingPosterRequests[requestId];
  delete pendingPosterRequests[requestId];
  if (!iconEl || !dataUrl) return;
  applyPosterImage(iconEl, dataUrl);
}

// ==========================================================================
// ACTION SHEET (on every card tap: Play/View + Download)
// ==========================================================================

function formatBytes(bytes) {
  var n = parseInt(bytes, 10);
  if (!n || n <= 0) return "";
  var units = ["B", "KB", "MB", "GB", "TB"];
  var i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + " " + units[i];
}

function openActionSheet(id, name, isFolder) {
  actionSheetTitle.textContent = name;

  var playIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  var folderIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>';
  var downloadIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>';

  var html = "";
  if (isFolder) {
    html += '<div class="action-option" id="actionPrimary">'
      + '<div class="a-icon">' + folderIcon + '</div>'
      + '<div><div class="a-label">View Folder</div><div class="a-sub">View files inside</div></div>'
      + '</div>';
    html += '<div class="action-option" id="actionDownload">'
      + '<div class="a-icon">' + downloadIcon + '</div>'
      + '<div><div class="a-label">Download Folder</div><div class="a-sub">Saved inside the app (offline)</div></div>'
      + '</div>';
  } else {
    html += '<div class="action-option" id="actionPrimary">'
      + '<div class="a-icon">' + playIcon + '</div>'
      + '<div><div class="a-label">Play</div><div class="a-sub">Stream and watch instantly</div></div>'
      + '</div>';
    html += '<div class="action-option" id="actionDownload">'
      + '<div class="a-icon">' + downloadIcon + '</div>'
      + '<div><div class="a-label">Download</div><div class="a-sub">Saved inside the app (offline)</div></div>'
      + '</div>';
  }
  actionSheetBody.innerHTML = html;

  document.getElementById("actionPrimary").addEventListener("click", function () {
    closeActionSheet();
    if (isFolder) {
      enterBrowseFolder(id, name);
    } else {
      Android.openFile(id, name);
    }
  });

  document.getElementById("actionDownload").addEventListener("click", function () {
    closeActionSheet();
    if (isFolder) {
      startFolderDownload(id, name);
    } else {
      startFileDownload(id, name);
    }
  });

  actionSheetOverlay.classList.add("active");
}

function closeActionSheet() {
  actionSheetOverlay.classList.remove("active");
}

// ==========================================================================
// DOWNLOADS
// Files are saved only in the app's own private storage (they don't show
// up in the public "Downloads" folder or in any file manager) - so no
// storage permission needs to be requested either. Progress (how much has
// downloaded, at what speed) is updated here through a live callback from Java:
//   onDownloadProgress(fileId, receivedBytes, totalBytes, speedBytesPerSec)
//   onDownloadComplete(fileId)
//   onDownloadError(fileId, message)
//   onDownloadCancelled(fileId)
//   onDownloadPaused(fileId)
//   onFolderDownloadQueued(filesJsonArrayString)  (folder scan ke baad)
// ==========================================================================

var DOWNLOADS_STORAGE_KEY = "dflix_downloads_v2";

function loadDownloads() {
  try {
    var raw = localStorage.getItem(DOWNLOADS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveDownloads(list) {
  try {
    localStorage.setItem(DOWNLOADS_STORAGE_KEY, JSON.stringify(list));
  } catch (e) { /* storage full/unavailable - ignore */ }
}

// When the app reopens, the real native task for items that had a
// "downloading" status doesn't survive (the process itself has
// restarted), so they're immediately marked as "error" (retry-able).
(function sanitizeStaleDownloadsOnLoad() {
  var list = loadDownloads();
  var changed = false;
  list.forEach(function (item) {
    if (item.status === "downloading") {
      item.status = "error";
      item.errorMsg = "Download stopped because the app was closed";
      changed = true;
    }
  });
  if (changed) saveDownloads(list);
})();

function upsertDownloadEntry(patch) {
  var list = loadDownloads();
  var idx = -1;
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === patch.id) { idx = i; break; }
  }
  if (idx === -1) {
    list.unshift(patch);
  } else {
    // Only update the fields, don't touch the position - otherwise on
    // every onDownloadProgress tick (which comes roughly every ~500ms)
    // this item would jump to the top of the list, and the whole
    // sequence (like Episode 1, Episode 2, Episode 3...) would keep
    // getting shuffled around.
    var merged = list[idx];
    for (var key in patch) {
      if (patch.hasOwnProperty(key)) merged[key] = patch[key];
    }
    list[idx] = merged;
  }
  if (list.length > 200) list = list.slice(0, 200);
  saveDownloads(list);
  return list;
}

// When a folder download starts, all its files are added to the list
// together, in their original (natural) order. Calling upsertDownloadEntry
// one at a time would reverse the order (the last file would end up on
// top) - so here the whole batch is prepended at once, in the correct order.
function upsertDownloadEntriesBatch(patches) {
  if (!patches || patches.length === 0) return;
  var list = loadDownloads();
  var newIds = {};
  patches.forEach(function (p) { newIds[p.id] = true; });
  list = list.filter(function (item) { return !newIds[item.id]; });
  list = patches.concat(list);
  if (list.length > 200) list = list.slice(0, 200);
  saveDownloads(list);
}

function findDownloadEntry(id) {
  var list = loadDownloads();
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

// For automatic situations like cancel/error, remove from the list without
// a confirmation - the file has already been deleted natively (LocalDownloadManager).
function removeDownloadEntryQuiet(id) {
  var list = loadDownloads().filter(function (i) { return i.id !== id; });
  saveDownloads(list);
  renderDownloadsList();
  refreshDownloadFolderViewIfOpen();
}

// If the user presses the "Delete/Cancel" button, show a confirmation popup first.
function openConfirmDelete(id, name) {
  var item = findDownloadEntry(id);
  var isDownloading = item && item.status === "downloading";
  confirmTitle.textContent = isDownloading ? "Cancel download?" : "Delete?";
  confirmMsg.textContent = isDownloading
    ? 'Stopping the download of "' + name + '" will delete the incomplete file.'
    : '"' + name + '" will be permanently deleted. This cannot be undone.';
  confirmDeleteBtn.onclick = function () {
    closeConfirm();
    performDelete(id, name);
  };
  confirmOverlay.classList.add("active");
}

function closeConfirm() {
  confirmOverlay.classList.remove("active");
}

// For deleting an entire folder (all files inside it, whether already
// downloaded or still in progress) with a single confirmation.
function openConfirmDeleteFolder(folderName) {
  var items = loadDownloads().filter(function (i) { return i.folderName === folderName; });
  confirmTitle.textContent = "Delete All";
  confirmMsg.textContent = 'All (' + items.length + ') files in "' + folderName + '" will be permanently deleted.';
  confirmDeleteBtn.onclick = function () {
    closeConfirm();
    performDeleteFolder(folderName);
  };
  confirmOverlay.classList.add("active");
}

function performDeleteFolder(folderName) {
  var items = loadDownloads().filter(function (i) { return i.folderName === folderName; });
  items.forEach(function (item) {
    try { Android.deleteDownloadedFile(item.id, item.name); } catch (e) { /* even on an older APK, still remove it from the list */ }
  });
  var list = loadDownloads().filter(function (i) { return i.folderName !== folderName; });
  saveDownloads(list);
  if (viewMode === "downloadFolder" && currentDownloadFolderName === folderName) {
    goDownloads();
  } else {
    renderDownloadsList();
  }
  showToast('"' + folderName + '" was deleted');
}

// The actual delete after confirmation: the native side also removes the file from disk.
function performDelete(id, name) {
  try {
    Android.deleteDownloadedFile(id, name);
  } catch (e) { /* even on an older APK, still remove it from the list */ }
  var list = loadDownloads().filter(function (i) { return i.id !== id; });
  saveDownloads(list);
  renderDownloadsList();
  refreshDownloadFolderViewIfOpen();
  showToast("Deleted");
}

function startFileDownload(fileId, fileName) {
  upsertDownloadEntry({
    id: fileId, name: fileName, isFolder: false,
    status: "downloading", received: 0, total: 0, speed: 0, ts: Date.now()
  });
  try {
    Android.downloadFile(fileId, fileName);
  } catch (e) {
    upsertDownloadEntry({ id: fileId, status: "error", errorMsg: "Download could not start" });
  }
  showToast("Download started: " + fileName);
  goDownloads();
}

function retryDownload(fileId) {
  var item = findDownloadEntry(fileId);
  if (!item) return;
  startFileDownload(item.id, item.name);
}

function startFolderDownload(folderId, folderName) {
  try {
    Android.downloadFolder(folderId, folderName);
  } catch (e) {
    showToast("Content download is not supported on this device");
    return;
  }
  showToast("Scanning folder: " + folderName);
  goDownloads();
}

// Once the native folder listing is complete, a downloading entry is
// added for each file (Java itself starts downloading all of them too).
// These files are shown in the Downloads tab "folder-wise" (grouped
// inside one folder) by folderName - exactly like the folder structure
// in Drive.
function onFolderDownloadQueued(filesJson, folderName) {
  var files = [];
  try { files = JSON.parse(filesJson); } catch (e) { files = []; }
  var patches = files.map(function (f) {
    return {
      id: f.id, name: f.name, isFolder: false, folderName: folderName,
      subPath: f.subPath || [],
      status: "downloading", received: 0, total: 0, speed: 0, ts: Date.now()
    };
  });
  upsertDownloadEntriesBatch(patches);
  if (viewMode === "downloads") renderDownloadsList();
}

function onDownloadProgress(fileId, receivedBytes, totalBytes, speedBytesPerSec) {
  upsertDownloadEntry({ id: fileId, status: "downloading", received: receivedBytes, total: totalBytes, speed: speedBytesPerSec });
  if (viewMode === "downloads") renderDownloadsList();
}

function onDownloadComplete(fileId) {
  upsertDownloadEntry({ id: fileId, status: "completed", speed: 0 });
  if (viewMode === "downloads") renderDownloadsList();
  var item = findDownloadEntry(fileId);
  showToast("Download complete: " + (item ? item.name : ""));
}

function onDownloadError(fileId, message) {
  upsertDownloadEntry({ id: fileId, status: "error", errorMsg: message || "Download failed", speed: 0 });
  if (viewMode === "downloads") renderDownloadsList();
}

function onDownloadCancelled(fileId) {
  removeDownloadEntryQuiet(fileId);
}

// Pause keeps the partial file - so unlike cancel, the row just switches
// to a "paused" state (with a Resume button) instead of disappearing.
function onDownloadPaused(fileId) {
  upsertDownloadEntry({ id: fileId, status: "paused", speed: 0 });
  if (viewMode === "downloads") renderDownloadsList();
}

function pauseSingleDownload(fileId) {
  upsertDownloadEntry({ id: fileId, status: "paused", speed: 0 }); // optimistic, native callback confirms it
  try { Android.pauseDownload(fileId); } catch (e) { /* older APK - ignore */ }
  if (viewMode === "downloads") renderDownloadsList();
}

function resumeSingleDownload(fileId) {
  var item = findDownloadEntry(fileId);
  if (!item) return;
  upsertDownloadEntry({ id: fileId, status: "downloading" });
  try {
    Android.downloadFile(item.id, item.name); // native side resumes from the .part file automatically
  } catch (e) {
    upsertDownloadEntry({ id: fileId, status: "error", errorMsg: "Could not resume" });
  }
  if (viewMode === "downloads") renderDownloadsList();
}

// "Pause" on the whole folder: every file in it that's currently
// downloading (or still waiting its turn in the native queue) is paused
// one by one - each keeps its own partial progress.
function pauseFolderDownloads(folderName) {
  var items = loadDownloads().filter(function (i) { return i.folderName === folderName; });
  items.forEach(function (item) {
    if (item.status === "downloading") pauseSingleDownload(item.id);
  });
  showToast('Paused "' + folderName + '"');
}

// "Continue"/Resume on the whole folder: every paused or failed file
// picks back up from where it stopped.
function continueFolderDownloads(folderName) {
  var items = loadDownloads().filter(function (i) { return i.folderName === folderName; });
  items.forEach(function (item) {
    if (item.status === "paused" || item.status === "error") resumeSingleDownload(item.id);
  });
  showToast('Continuing "' + folderName + '"');
}

function goDownloads() {
  closeSearch();
  viewMode = "downloads";
  currentDownloadFolderName = null;
  currentDownloadSubPath = [];
  appRoot.classList.remove("browse-mode");
  setActiveNav(navDownloads);
  homeViewEl.classList.add("hidden");
  contentEl.classList.add("hidden");
  downloadsViewEl.classList.remove("hidden");
  renderDownloadsList();
}

function renderDownloadsList() {
  var list = loadDownloads();

  if (list.length === 0) {
    downloadsListEl.innerHTML = "";
    showStateScreen(downloadsListEl, "\u2B07\uFE0F", "No downloads",
      "Tap on any movie or folder and press \"Download\".");
    return;
  }

  // Files downloaded from a folder are grouped by that folder's name
  // (so it shows the same structure it had in Drive); files that were
  // downloaded directly (without a folder) are counted as standalone.
  var groups = {};
  var groupOrder = [];
  var standalone = [];

  list.forEach(function (item) {
    if (item.folderName) {
      if (!groups[item.folderName]) {
        groups[item.folderName] = [];
        groupOrder.push(item.folderName);
      }
      groups[item.folderName].push(item);
    } else {
      standalone.push(item);
    }
  });

  // Until all of a folder's files have downloaded, it shows below as
  // list-style progress rows. Once the whole folder is complete, it
  // becomes a normal folder card (just like on the home page - a 📁 icon
  // + name); tapping it opens the files inside in a poster-grid.
  var completeCardsHtml = "";
  var inProgressHtml = "";

  groupOrder.forEach(function (folderName) {
    var items = groups[folderName];
    var completedCount = items.filter(function (i) { return i.status === "completed"; }).length;
    var allDone = completedCount === items.length && items.length > 0;
    if (allDone) {
      completeCardsHtml += buildDownloadFolderCardHtml(folderName, items);
    } else {
      inProgressHtml += renderDownloadFolderGroupHtml(folderName, items, completedCount);
    }
  });

  standalone.forEach(function (item) {
    if (item.status === "completed") {
      completeCardsHtml += buildDownloadCardHtml(item);
    } else {
      inProgressHtml += renderDownloadRowHtml(item);
    }
  });

  var html = "";
  if (completeCardsHtml) {
    html += '<div class="movie-grid downloads-grid">' + completeCardsHtml + '</div>';
  }
  html += inProgressHtml;

  downloadsListEl.innerHTML = html;
  attachDownloadRowHandlers();
  attachDownloadCardHandlers(downloadsListEl);
  attachDownloadFolderCardHandlers(downloadsListEl);
  attachFolderGroupDeleteHandlers(downloadsListEl);
  lazyLoadPostersIn(downloadsListEl);
}

function attachFolderGroupDeleteHandlers(container) {
  container.querySelectorAll(".download-folder-header [data-remove-folder]").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      openConfirmDeleteFolder(btn.getAttribute("data-remove-folder"));
    });
  });
  container.querySelectorAll(".download-folder-header [data-pause-folder]").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      pauseFolderDownloads(btn.getAttribute("data-pause-folder"));
    });
  });
  container.querySelectorAll(".download-folder-header [data-continue-folder]").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      continueFolderDownloads(btn.getAttribute("data-continue-folder"));
    });
  });
}

// List-style progress rows only for folders that are currently
// downloading (or failed) - completed folders don't show up here, they
// become a folder-card in the grid above.
function renderDownloadFolderGroupHtml(folderName, items, completedCount) {
  var hasActive = items.some(function (i) { return i.status === "downloading"; });
  var hasResumable = items.some(function (i) { return i.status === "paused" || i.status === "error"; });
  var html = '<div class="download-folder-group">'
    + '<div class="download-folder-header">'
    + '<div class="d-icon">\uD83D\uDCC1</div>'
    + '<div class="d-info">'
    + '<div class="d-name">' + escapeHtml(folderName) + '</div>'
    + '<div class="d-sub">' + completedCount + ' / ' + items.length + ' files complete</div>'
    + '</div>'
    + '<div class="d-header-actions">';
  if (hasActive) {
    html += '<button class="d-btn pause" data-pause-folder="' + escapeHtml(folderName) + '" title="Pause all">'
      + '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>'
      + '</button>';
  }
  if (hasResumable) {
    html += '<button class="d-btn resume" data-continue-folder="' + escapeHtml(folderName) + '" title="Continue download">'
      + '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
      + '</button>';
  }
  html += '<button class="d-btn remove" data-remove-folder="' + escapeHtml(folderName) + '" title="Delete entire folder">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>'
    + '</button>'
    + '</div>'
    + '</div>'
    + '<div class="download-folder-items">';
  items.forEach(function (item) { html += renderDownloadRowHtml(item); });
  html += '</div></div>';
  return html;
}

// A fully downloaded folder becomes a normal folder-card - just like on
// the home page (poster/📁 icon + name). The poster also comes from the
// same TMDB lookup used for folders during normal browsing.
function buildDownloadFolderCardHtml(folderName, items) {
  posterUidSeq++;
  var uid = "dlfolder_u" + posterUidSeq;

  var html = '<div class="grid-card folder-card download-complete-folder-card" '
    + 'data-folder-name="' + escapeHtml(folderName) + '" tabindex="0">';
  html += '<div class="no-poster" id="' + uid + '" data-poster-query="' + escapeHtml(folderName) + '"><div class="gi">\uD83D\uDCC1</div></div>';
  html += '<button class="grid-remove-btn" data-remove-folder="' + escapeHtml(folderName) + '" title="Delete entire folder">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button>';
  html += '<div class="grid-name">' + escapeHtml(folderName) + '</div>';
  html += '</div>';
  return html;
}

function attachDownloadFolderCardHandlers(container) {
  container.querySelectorAll(".download-complete-folder-card").forEach(function (card) {
    var folderName = card.getAttribute("data-folder-name");
    card.addEventListener("click", function (e) {
      if (e.target.closest(".grid-remove-btn")) return;
      enterDownloadFolder(folderName);
    });

    var removeBtn = card.querySelector(".grid-remove-btn");
    if (removeBtn) {
      removeBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        openConfirmDeleteFolder(folderName);
      });
    }
  });
}

// Entering a downloaded folder from the Downloads tab - if that folder
// had subfolders inside it, the same nested structure (folder -> subfolder
// -> file) is available here too, just like Drive browsing.
var currentDownloadSubPath = []; // which subfolder we're currently inside (chain of names)

function enterDownloadFolder(folderName) {
  closeSearch();
  currentDownloadFolderName = folderName;
  currentDownloadSubPath = [];
  viewMode = "downloadFolder";
  appRoot.classList.add("browse-mode");
  homeViewEl.classList.add("hidden");
  downloadsViewEl.classList.add("hidden");
  contentEl.classList.remove("hidden");
  renderDownloadFolderGrid(folderName, currentDownloadSubPath);
}

function enterDownloadSubfolder(name) {
  currentDownloadSubPath.push(name);
  renderDownloadFolderGrid(currentDownloadFolderName, currentDownloadSubPath);
}

// Go up one level - if inside a subfolder, go up a level, otherwise
// go straight to the Downloads tab. Both handleBackPress() and the
// header's back-chevron (goBackFolder) use this.
function exitDownloadFolderLevel() {
  if (currentDownloadSubPath.length > 0) {
    currentDownloadSubPath.pop();
    renderDownloadFolderGrid(currentDownloadFolderName, currentDownloadSubPath);
  } else {
    goDownloads();
  }
}

// What's at the exact level of the given subPath (folder-chain) -
// the direct files at that level, and the next subfolders inside that
// level (along with all their descendant items, so progress/completion
// can be figured out).
function getDownloadFolderLevel(folderName, subPath) {
  var allItems = loadDownloads().filter(function (i) { return i.folderName === folderName; });
  var files = [];
  var subfolderMap = {};
  var subfolderOrder = [];

  allItems.forEach(function (item) {
    var itemPath = item.subPath || [];
    for (var i = 0; i < subPath.length; i++) {
      if (itemPath[i] !== subPath[i]) return; // doesn't fall under this subPath
    }
    if (itemPath.length === subPath.length) {
      files.push(item);
    } else {
      var nextName = itemPath[subPath.length];
      if (!subfolderMap[nextName]) {
        subfolderMap[nextName] = [];
        subfolderOrder.push(nextName);
      }
      subfolderMap[nextName].push(item);
    }
  });

  return {
    files: files,
    subfolders: subfolderOrder.map(function (name) { return { name: name, items: subfolderMap[name] }; })
  };
}

function renderDownloadFolderGrid(folderName, subPath) {
  var level = getDownloadFolderLevel(folderName, subPath);
  var titleText = subPath.length > 0 ? subPath[subPath.length - 1] : folderName;

  contentEl.innerHTML = '<div class="row-header" style="padding:16px 16px 6px;"><div class="row-title">'
    + escapeHtml(titleText) + '</div>'
    + '<button class="row-seeall" id="btnDeleteWholeFolder">Delete All</button>'
    + '</div><div class="movie-grid" id="downloadFolderGrid"></div>';
  var gridEl = document.getElementById("downloadFolderGrid");

  var deleteAllBtn = document.getElementById("btnDeleteWholeFolder");
  if (deleteAllBtn) {
    deleteAllBtn.addEventListener("click", function () {
      openConfirmDeleteFolder(folderName);
    });
  }

  if (level.subfolders.length === 0 && level.files.length === 0) {
    showStateScreen(contentEl, "\uD83D\uDCED", "Empty",
      "All files in this folder have been deleted.");
    return;
  }

  var html = "";
  level.subfolders.forEach(function (sf) { html += buildDownloadSubfolderCardHtml(sf.name, sf.items); });
  level.files.forEach(function (item) { html += buildDownloadCardHtml(item); });
  gridEl.innerHTML = html;
  attachDownloadSubfolderCardHandlers(contentEl);
  attachDownloadCardHandlers(contentEl);
  lazyLoadPostersIn(contentEl);
}

// Card for a subfolder inside a downloaded folder - poster/📁 icon +
// name, and if not everything inside that subfolder has downloaded yet,
// an "x/y" badge too (how many files are complete).
function buildDownloadSubfolderCardHtml(name, items) {
  posterUidSeq++;
  var uid = "dlsubfolder_u" + posterUidSeq;
  var completedCount = items.filter(function (i) { return i.status === "completed"; }).length;

  var html = '<div class="grid-card folder-card download-subfolder-card" '
    + 'data-subfolder-name="' + escapeHtml(name) + '" tabindex="0">';
  html += '<div class="no-poster" id="' + uid + '" data-poster-query="' + escapeHtml(name) + '"><div class="gi">\uD83D\uDCC1</div></div>';
  if (completedCount < items.length) {
    html += '<span class="badge">' + completedCount + '/' + items.length + '</span>';
  }
  html += '<div class="grid-name">' + escapeHtml(name) + '</div>';
  html += '</div>';
  return html;
}

function attachDownloadSubfolderCardHandlers(container) {
  container.querySelectorAll(".download-subfolder-card").forEach(function (card) {
    var name = card.getAttribute("data-subfolder-name");
    card.addEventListener("click", function () {
      enterDownloadSubfolder(name);
    });
  });
}

// If the user is currently inside a downloaded folder/subfolder, refresh
// that same level with fresh data after a delete. If that level is now
// empty, go up one level at a time until something is found or the root
// is reached; if the entire top-folder is now empty, send them back to
// the Downloads tab.
function refreshDownloadFolderViewIfOpen() {
  if (viewMode !== "downloadFolder" || !currentDownloadFolderName) return;
  var anyLeftInFolder = loadDownloads().some(function (i) { return i.folderName === currentDownloadFolderName; });
  if (!anyLeftInFolder) {
    goDownloads();
    return;
  }
  while (currentDownloadSubPath.length > 0) {
    var level = getDownloadFolderLevel(currentDownloadFolderName, currentDownloadSubPath);
    if (level.subfolders.length > 0 || level.files.length > 0) break;
    currentDownloadSubPath.pop();
  }
  renderDownloadFolderGrid(currentDownloadFolderName, currentDownloadSubPath);
}

// For a completed download, a card just like a normal grid-card
// (poster + name), except tapping it plays the local file directly, and
// there's a small remove button for deleting it.
function buildDownloadCardHtml(item) {
  posterUidSeq++;
  var uid = "dlposter_u" + posterUidSeq;

  var html = '<div class="grid-card download-complete-card" '
    + 'data-id="' + item.id + '" data-name="' + escapeHtml(item.name) + '" tabindex="0">';
  html += '<div class="no-poster" id="' + uid + '" data-poster-query="' + escapeHtml(item.name) + '"><div class="gi">' + getFileIcon(item.name) + '</div></div>';
  html += '<span class="badge saved">\u2713 Saved</span>';
  html += '<button class="grid-remove-btn" data-remove-id="' + item.id + '" title="Remove">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button>';
  html += '<div class="grid-name">' + escapeHtml(item.name) + '</div>';
  html += '</div>';
  return html;
}

function attachDownloadCardHandlers(container) {
  container.querySelectorAll(".download-complete-card").forEach(function (card) {
    var id = card.getAttribute("data-id");
    var name = card.getAttribute("data-name");

    card.addEventListener("click", function (e) {
      if (e.target.closest(".grid-remove-btn")) return;
      try {
        Android.playLocalFile(id, name);
      } catch (err) {
        Android.openFile(id, name);
      }
    });

    var removeBtn = card.querySelector(".grid-remove-btn");
    if (removeBtn) {
      removeBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        openConfirmDelete(id, name);
      });
    }
  });
}

function renderDownloadRowHtml(item) {
  var pct = (item.total > 0) ? Math.min(100, Math.round((item.received / item.total) * 100)) : 0;
  var sizeLine = (item.total > 0)
    ? formatBytes(item.received) + " / " + formatBytes(item.total)
    : formatBytes(item.received);
  var subLine;
  if (item.status === "downloading") {
    subLine = pct + "%" + (sizeLine ? " \u00B7 " + sizeLine : "")
      + (item.speed > 0 ? " \u00B7 " + formatBytes(item.speed) + "/s" : " \u00B7 Starting...");
  } else if (item.status === "paused") {
    subLine = "\u23F8\uFE0F Paused" + (sizeLine ? " \u00B7 " + pct + "% \u00B7 " + sizeLine : "");
  } else if (item.status === "completed") {
    subLine = "Download complete" + (item.total > 0 ? " \u00B7 " + formatBytes(item.total) : "");
  } else {
    subLine = "\u26A0\uFE0F " + escapeHtml(item.errorMsg || "Download failed");
  }

  var html = '<div class="download-row" data-id="' + item.id + '">'
    + '<div class="d-icon">' + getFileIcon(item.name) + '</div>'
    + '<div class="d-info">'
    + '<div class="d-name">' + escapeHtml(item.name) + '</div>'
    + '<div class="d-sub">' + subLine + '</div>';
  if (item.status === "downloading" || item.status === "paused") {
    html += '<div class="d-progress-track"><div class="d-progress-fill" style="width:' + pct + '%"></div></div>';
  }
  html += '</div>'
    + '<div class="d-actions">';

  if (item.status === "completed") {
    html += '<button class="d-btn" data-act="play" title="Play">'
      + '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
      + '</button>';
  } else if (item.status === "error" || item.status === "paused") {
    html += '<button class="d-btn resume" data-act="resume" title="' + (item.status === "paused" ? "Resume" : "Retry") + '">'
      + '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
      + '</button>';
  } else if (item.status === "downloading") {
    html += '<button class="d-btn pause" data-act="pause" title="Pause">'
      + '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>'
      + '</button>';
  }

  html += '<button class="d-btn remove" data-act="remove" title="' + (item.status === "downloading" ? "Cancel" : "Remove") + '">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>'
    + '</button>'
    + '</div>'
    + '</div>';
  return html;
}

function attachDownloadRowHandlers() {
  downloadsListEl.querySelectorAll(".download-row").forEach(function (row) {
    var id = row.getAttribute("data-id");
    var item = findDownloadEntry(id);
    if (!item) return;

    var playBtn = row.querySelector('[data-act="play"]');
    if (playBtn) {
      playBtn.addEventListener("click", function () {
        try {
          Android.playLocalFile(item.id, item.name);
        } catch (e) {
          Android.openFile(item.id, item.name);
        }
      });
    }

    var resumeBtn = row.querySelector('[data-act="resume"]');
    if (resumeBtn) {
      resumeBtn.addEventListener("click", function () {
        resumeSingleDownload(item.id);
      });
    }

    var pauseBtn = row.querySelector('[data-act="pause"]');
    if (pauseBtn) {
      pauseBtn.addEventListener("click", function () {
        pauseSingleDownload(item.id);
      });
    }

    row.querySelector('[data-act="remove"]').addEventListener("click", function () {
      openConfirmDelete(item.id, item.name);
    });
  });
}

// ---------- Helpers ----------
function getFileIcon(name) {
  var lower = name.toLowerCase();
  if (lower.endsWith(".mkv") || lower.endsWith(".mp4") || lower.endsWith(".avi") || lower.endsWith(".mov")) return "\uD83C\uDFAC";
  if (lower.endsWith(".mp3") || lower.endsWith(".m4a")) return "\uD83C\uDFB5";
  if (lower.endsWith(".jpg") || lower.endsWith(".png") || lower.endsWith(".jpeg")) return "\uD83D\uDDBC\uFE0F";
  if (lower.endsWith(".pdf")) return "\uD83D\uDCC4";
  return "\uD83D\uDCE6";
}

function escapeHtml(str) {
  var div = document.createElement("div");
  div.innerText = str == null ? "" : str;
  return div.innerHTML;
                              }
