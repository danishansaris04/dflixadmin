// ==========================================================================
// D-FLIX front-end logic
// Talks to the native Android bridge exposed as window.Android
// (isLoggedIn, login, listFiles, searchFiles, resolvePoster, openFile,
//  downloadFile, downloadFolder)
//
// VIEW MODES:
//   'home'      -> Netflix-style rows: har top-level folder (Marvel, Anime &
//                  Animation, ...) ek row hai, us folder ke andar jo bhi
//                  folders/files hain wahi row me cards ban ke dikhte hain.
//   'browse'    -> Purana grid-drilldown view (kisi bhi folder ke andar ghuso
//                  to sab kuch waisi hi 3-column grid me dikhta hai jaisa
//                  pehle dikhta tha).
//   'downloads' -> Downloads tab: jo bhi cheez download ke liye tap ki gayi
//                  thi uski list yahan dikhti hai.
//
// CARD CLICK BEHAVIOUR:
//   Kisi bhi card (file ya folder) par tap karne se ek action-sheet popup
//   khulta hai:
//     - File hui to:   "Play" (turant stream) ya "Download" (device me save)
//     - Folder hui to: "View" (andar ghuso)   ya "Download" (poori folder
//                       ke andar ki files download)
//   Download dabane par woh item Downloads tab me chala jaata hai.
// ==========================================================================

var LOCKED_ROOT_FOLDER_ID = "17s88x00QQXAnTQtFWasBIOcgRqziTEnQ";

// ==========================================================================
// CUSTOM POSTERS (admin.html se Firebase Realtime Database me set kiye hue)
// Admin panel me kisi folder/file ke exact naam ke against ek poster URL
// save hota hai; app yahan se sabko ek baar me fetch karke cache kar leta
// hai, aur TMDB se poster maangne se PEHLE yahi check karta hai - agar
// admin ne custom poster laga rakha hai to wahi use hota hai.
// ==========================================================================

var FIREBASE_DB_URL = "https://dflix-7b2d2-default-rtdb.firebaseio.com";
var customPosterMap = {}; // encodedKey(name) -> image URL

// Firebase Realtime Database ke key me ". # $ [ ] /" allowed nahi hote,
// lekin file/folder naam me dots (jaise "Movie.2023.1080p.mkv") aam hote
// hain - isliye un characters ko ek safe, reversible-jaisi encoding me
// badal dete hain. admin.html me bhi bilkul yahi function hai, taaki
// dono taraf ka key hamesha match kare.
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
      // Firebase unreachable / offline - bas TMDB posters hi chalte rahenge
    });
}

var viewMode = "home";
var currentDownloadFolderName = null; // downloads tab me abhi kis folder ke andar hain
var folderStack = [{ id: LOCKED_ROOT_FOLDER_ID, name: "My Drive" }];
var currentFolderId = LOCKED_ROOT_FOLDER_ID;
var searchTimer = null;

var homeRowsCache = null;   // { folders: [...], looseFiles: [...] } - root listing cache
var pendingHeroChecks = 0;

// Hero banner ab ek carousel hai: 5-6 trending items collect karke har
// HERO_ROTATE_MS par ek se doosre par crossfade hote rahte hain.
var HERO_MAX_CANDIDATES = 6;
var HERO_ROTATE_MS = 5000;
var heroCandidates = [];   // [{ id, name, rowTitle, poster }]
var heroCandidateIndex = 0;
var heroActiveLayer = 0;   // kaunsi bg layer (0/1) abhi visible hai
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

// ==========================================================================
// TV REMOTE NAVIGATION (bottom nav bar)
// Android side D-pad key events ko WebView ke andar normal keyboard
// KeyboardEvent (ArrowLeft/ArrowRight/Enter) ki tarah bhej deta hai (jab
// tak WebView ko Android focus mila ho - dekho MainActivity.java). Yahan
// bas un keys ko sunke bottom-nav ke items ke beech left/right cursor move
// karte hain aur "Enter"/OK dabane par jahan cursor hai wahi tab khulta hai.
// ==========================================================================

var tvNavItems = [];     // bottom-nav ke saare buttons, left-to-right order me
var tvNavIndex = 0;      // abhi remote ka "cursor" kis index par hai
var tvNavActive = false; // jab tak user pehli baar D-pad na dabaye, koi highlight nahi dikhta

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
    || actionSheetOverlay.classList.contains("active");
}

function setTvNavFocus(index) {
  if (tvNavItems.length === 0) return;
  if (index < 0) index = 0;
  if (index > tvNavItems.length - 1) index = tvNavItems.length - 1;

  for (var i = 0; i < tvNavItems.length; i++) tvNavItems[i].classList.remove("focused");
  tvNavIndex = index;
  var el = tvNavItems[tvNavIndex];
  el.classList.add("focused");
  try { el.focus(); } catch (e) { /* kuch WebView versions me focus() fail ho sakta hai - koi baat nahi */ }
  tvNavActive = true;
}

function moveTvNavFocus(delta) {
  if (!tvNavActive) {
    // Pehli baar D-pad dabane par, abhi jo tab active hai wahi se cursor shuru ho
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

// Nav item par touch/mouse se tap kiya to bhi remote-cursor ko usi item
// par sync kar dete hain, taaki agla D-pad press wahin se aage badhe.
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
});

document.addEventListener("visibilitychange", function () {
  if (!document.hidden && loginScreen && !loginScreen.classList.contains("hidden")) {
    checkLogin();
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
  loginStatus.textContent = "Google login khul raha hai...";
  Android.login();
});

function onLoginComplete(success) {
  if (success) {
    loginStatus.textContent = "";
    showMain();
  } else {
    loginStatus.textContent = "Login fail ho gaya, dobara try karein.";
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
// "Movie" tab = root ke "Bollywood" + "Hollywood" naam wale folders ka
// content ek saath. "Web Series" tab = root ke "Web Series" naam wale
// folder ka content. Naam case-insensitive match hote hain.
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

// Root folder listing already cache me ho to wahi use karo, warna fetch karo
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

// Movie tab me Bollywood/Hollywood ke alawa in "nested paths" ki files bhi
// shaamil hoti hain - har entry root se andar tak ke folder-naamon ka
// sequence hai. Yahan naya path add karke Movie tab me kisi bhi gehre folder
// ki files aasaani se laayi ja sakti hain.
var MOVIE_TAB_EXTRA_PATHS = [
  ["Marvel", "Avengers", "480p"],
  ["Harry Potter", "480p"],
  ["Pirates of the Caribbean", "480p"],
  ["Transformer", "480p"],
  ["DC", "480p"]
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

// Folder naam compare karte waqt case, extra spaces, aur punctuation ignore
// karte hain (e.g. "Hollywood", "hollywood ", "Holly-Wood" sab match karega),
// taaki thoda bhi naming farak hone par category tab khaali na reh jaaye.
function normalizeFolderName(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Fisher-Yates shuffle - Bollywood/Hollywood ek line/order me (jaise Drive
// me pehle se sorted hain) na dikhein, balki har baar mix/random order me.
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
      showStateScreen(gridEl, "\uD83D\uDCED", "Kuch nahi mila",
        '"' + folderNameList.join(" / ") + '" naam ka folder Drive me nahi mila.');
      return;
    }

    var combined = [];
    var remaining = totalTasks;

    function taskDone() {
      remaining--;
      if (remaining === 0) {
        if (combined.length === 0) {
          showStateScreen(gridEl, "\uD83D\uDCED", "Kuch nahi mila",
            '"' + folderNameList.join(" / ") + '" naam ka folder Drive me nahi mila.');
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

// Root ke andar naam se ek folder dhoondh kar (jaise "Marvel"), phir uske
// andar agla naam (jaise "Avengers"), phir agla (jaise "480p") - is tarah
// path ke aakhri folder tak pahunch kar wahan ki saari files callback me
// deta hai. Kisi bhi step par folder na mile to khaali list de deta hai
// (baaki category items par koi asar nahi padta).
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
  showToast(label + " jaldi aa raha hai!");
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

// Visible back-chevron in header (browse-mode me) + hardware-back dono isi ko use karte hain
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
    showStateScreen(rowsContainerEl, "\u26A0\uFE0F", "Kuch gadbad ho gayi", escapeHtml(data.error));
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
    showStateScreen(rowsContainerEl, "\uD83D\uDCED", "Kuch nahi mila", "Yeh Drive folder khali hai.");
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

// Har row se ek-ek trending video file uthake HERO_MAX_CANDIDATES tak
// candidates ikattha karte hain - inhi ke beech hero banner rotate hota hai.
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

// Home ke sabhi rows load ho chuke hain - agar kam se kam ek trending
// candidate mila to carousel shuru karo, warna "Coming Soon" dikhao.
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
  heroPlayBtn.onclick = function () { showToast("Jaldi aa raha hai!"); };
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
    // Purani APK build jisme resolveBackdrop nahi hai - poster hi sahi
    try { Android.resolvePoster(fileName, "heroReq_" + idx); } catch (e2) { /* ignore */ }
  }
}

// ==========================================================================
// BROWSE VIEW (purana grid drilldown - folder ke andar ghusne ke baad)
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
    Android.searchFiles(keyword, "onSearchResults");
  }, 400);
});

function onSearchResults(data) {
  var keyword = searchInput.value.trim();
  searchResultLabel.classList.remove("hidden");
  searchResultLabel.textContent = 'Results for "' + keyword + '"';
  renderGrid(data, searchBody, true);
}

// ==========================================================================
// SHARED CARD RENDERING (grid ho ya row, dono isi se banate hain)
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

// ---------- Render (classic 3-column grid - browse-mode + search dono use karte hain) ----------
function renderGrid(data, container, isSearch) {
  if (data && data.error) {
    if (data.error === "not_logged_in") {
      showLogin();
      return;
    }
    showStateScreen(container, "\u26A0\uFE0F", "Kuch gadbad ho gayi", escapeHtml(data.error));
    showToast("Error: " + data.error);
    return;
  }

  var files = (data && data.files) ? data.files : [];

  if (files.length === 0) {
    showStateScreen(container, "\uD83D\uDCED", "Kuch nahi mila",
      isSearch ? "Is naam se koi file nahi mili." : "Yeh folder khali hai.");
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
// TMDB POSTERS (lazy load) - ab folder-cards aur video-cards dono ke liye
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
    // Android.resolvePoster available nahi hai (purana build) - icon hi rehne do
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
// ACTION SHEET (har card tap par: Play/View + Download)
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
      + '<div><div class="a-label">Folder View karein</div><div class="a-sub">Andar ki files dekhein</div></div>'
      + '</div>';
    html += '<div class="action-option" id="actionDownload">'
      + '<div class="a-icon">' + downloadIcon + '</div>'
      + '<div><div class="a-label">Folder Download karein</div><div class="a-sub">App ke andar hi save hongi (offline)</div></div>'
      + '</div>';
  } else {
    html += '<div class="action-option" id="actionPrimary">'
      + '<div class="a-icon">' + playIcon + '</div>'
      + '<div><div class="a-label">Play karein</div><div class="a-sub">Turant stream karke dekhein</div></div>'
      + '</div>';
    html += '<div class="action-option" id="actionDownload">'
      + '<div class="a-icon">' + downloadIcon + '</div>'
      + '<div><div class="a-label">Download karein</div><div class="a-sub">App ke andar hi save hoga (offline)</div></div>'
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
// Files sirf app ke apne private storage me save hote hain (public
// "Downloads" folder ya kisi file-manager me nahi dikhte) - isliye koi
// storage permission bhi nahi maangni padti. Progress (kitna download hua,
// kitni speed) Java se live callback ke through yahan update hota hai:
//   onDownloadProgress(fileId, receivedBytes, totalBytes, speedBytesPerSec)
//   onDownloadComplete(fileId)
//   onDownloadError(fileId, message)
//   onDownloadCancelled(fileId)
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

// App dobara khulne par purane "downloading" status wale items ka asli
// native task zinda nahi rehta (process hi restart ho chuka hota hai),
// isliye unhe turant "error" (retry-able) maan lete hain.
(function sanitizeStaleDownloadsOnLoad() {
  var list = loadDownloads();
  var changed = false;
  list.forEach(function (item) {
    if (item.status === "downloading") {
      item.status = "error";
      item.errorMsg = "App band hone se download ruk gaya tha";
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
    // Sirf fields update karo, position ko chhedo mat - warna har
    // onDownloadProgress tick par (jo har ~500ms me aata hai) ye item
    // list ke top par chala jaata, aur poori sequence (jaise Episode 1,
    // Episode 2, Episode 3...) baar baar shuffle ho jaati.
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

// Folder download shuru karte waqt saari files ek saath, unke original
// (natural) sequence me hi list me daalta hai. Ek-ek karke upsertDownloadEntry
// bulane se order ulta ho jaata (last file sabse upar aa jaati) - isliye
// yahan ek hi baar me poore batch ko sahi order me prepend karte hain.
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

// Cancel/error jaisi automatic situations me list se hata dena (bina confirm ke) -
// isme file already delete ho chuki hoti hai native side par (LocalDownloadManager).
function removeDownloadEntryQuiet(id) {
  var list = loadDownloads().filter(function (i) { return i.id !== id; });
  saveDownloads(list);
  renderDownloadsList();
  refreshDownloadFolderViewIfOpen();
}

// User "Delete/Cancel" button dabaye to pehle confirm popup dikhao.
function openConfirmDelete(id, name) {
  var item = findDownloadEntry(id);
  var isDownloading = item && item.status === "downloading";
  confirmTitle.textContent = isDownloading ? "Download cancel karein?" : "Delete karein?";
  confirmMsg.textContent = isDownloading
    ? '"' + name + '" ka download rok kar adhoori file delete ho jaayegi.'
    : '"' + name + '" hamesha ke liye delete ho jaayegi. Ye wapas nahi aayegi.';
  confirmDeleteBtn.onclick = function () {
    closeConfirm();
    performDelete(id, name);
  };
  confirmOverlay.classList.add("active");
}

function closeConfirm() {
  confirmOverlay.classList.remove("active");
}

// Poori folder (uske andar ki saari files, chahe download ho chuki ho ya
// abhi chal rahi ho) ek hi confirm ke saath delete karne ke liye.
function openConfirmDeleteFolder(folderName) {
  var items = loadDownloads().filter(function (i) { return i.folderName === folderName; });
  confirmTitle.textContent = "Pura folder delete karein?";
  confirmMsg.textContent = '"' + folderName + '" ki saari (' + items.length + ') files hamesha ke liye delete ho jaayengi.';
  confirmDeleteBtn.onclick = function () {
    closeConfirm();
    performDeleteFolder(folderName);
  };
  confirmOverlay.classList.add("active");
}

function performDeleteFolder(folderName) {
  var items = loadDownloads().filter(function (i) { return i.folderName === folderName; });
  items.forEach(function (item) {
    try { Android.deleteDownloadedFile(item.id, item.name); } catch (e) { /* purani APK ho to bhi list se to hata hi dete hain */ }
  });
  var list = loadDownloads().filter(function (i) { return i.folderName !== folderName; });
  saveDownloads(list);
  if (viewMode === "downloadFolder" && currentDownloadFolderName === folderName) {
    goDownloads();
  } else {
    renderDownloadsList();
  }
  showToast('"' + folderName + '" delete ho gayi');
}

// Confirm ke baad asli delete: native side file disk se bhi hata deta hai.
function performDelete(id, name) {
  try {
    Android.deleteDownloadedFile(id, name);
  } catch (e) { /* purani APK ho to bhi list se to hata hi dete hain */ }
  var list = loadDownloads().filter(function (i) { return i.id !== id; });
  saveDownloads(list);
  renderDownloadsList();
  refreshDownloadFolderViewIfOpen();
  showToast("Delete ho gaya");
}

function startFileDownload(fileId, fileName) {
  upsertDownloadEntry({
    id: fileId, name: fileName, isFolder: false,
    status: "downloading", received: 0, total: 0, speed: 0, ts: Date.now()
  });
  try {
    Android.downloadFile(fileId, fileName);
  } catch (e) {
    upsertDownloadEntry({ id: fileId, status: "error", errorMsg: "Download shuru nahi ho paya" });
  }
  showToast("Download shuru: " + fileName);
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
    showToast("Folder download is device par support nahi hai");
    return;
  }
  showToast("Folder scan ho raha hai: " + folderName);
  goDownloads();
}

// Native folder listing complete hone ke baad har file ke liye ek downloading
// entry add hoti hai (Java khud sabki download bhi shuru kar deta hai).
// folderName se in files ko Downloads tab me "folder-wise" (ek group ke
// andar) dikhaya jaata hai - bilkul waise hi jaise Drive me folder-structure
// hoti hai.
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
  upsertDownloadEntry({ id: fileId, status: "error", errorMsg: message || "Download fail ho gaya", speed: 0 });
  if (viewMode === "downloads") renderDownloadsList();
}

function onDownloadCancelled(fileId) {
  removeDownloadEntryQuiet(fileId);
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
    showStateScreen(downloadsListEl, "\u2B07\uFE0F", "Koi download nahi",
      "Kisi bhi movie ya folder par tap karke \"Download\" dabayein.");
    return;
  }

  // folder se download ki gayi files ko usi folder ke naam se group karte
  // hain (Drive me jaisi structure thi waisi hi yahan bhi dikhe); jo files
  // seedhe (bina folder ke) download hui hain wo standalone gin li jaati hain.
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

  // Jab tak folder ki saari files download nahi ho jaatin, wo neeche
  // list-style progress rows me dikhta hai. Poori folder complete hote hi
  // wahi ab ek normal folder card ban jaata hai (bilkul home page jaisa -
  // 📁 icon + naam), tap karne par andar ki files poster-grid me khulti hain.
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
}

// Sirf abhi download ho rahe (ya fail hue) folder ke liye list-style
// progress rows - complete ho chuki folders yahan nahi aatin, wo upar
// grid me folder-card ban jaati hain.
function renderDownloadFolderGroupHtml(folderName, items, completedCount) {
  var html = '<div class="download-folder-group">'
    + '<div class="download-folder-header">'
    + '<div class="d-icon">\uD83D\uDCC1</div>'
    + '<div class="d-info">'
    + '<div class="d-name">' + escapeHtml(folderName) + '</div>'
    + '<div class="d-sub">' + completedCount + ' / ' + items.length + ' files complete</div>'
    + '</div>'
    + '<button class="d-btn remove" data-remove-folder="' + escapeHtml(folderName) + '" title="Pura folder delete karein">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>'
    + '</button>'
    + '</div>'
    + '<div class="download-folder-items">';
  items.forEach(function (item) { html += renderDownloadRowHtml(item); });
  html += '</div></div>';
  return html;
}

// Poori tarah download ho chuki folder ek normal folder-card ban jaati hai -
// bilkul home page jaisi (poster/📁 icon + naam). Poster bhi wahi TMDB
// lookup se aata hai jo normal browsing me folders ke liye hota hai.
function buildDownloadFolderCardHtml(folderName, items) {
  posterUidSeq++;
  var uid = "dlfolder_u" + posterUidSeq;

  var html = '<div class="grid-card folder-card download-complete-folder-card" '
    + 'data-folder-name="' + escapeHtml(folderName) + '" tabindex="0">';
  html += '<div class="no-poster" id="' + uid + '" data-poster-query="' + escapeHtml(folderName) + '"><div class="gi">\uD83D\uDCC1</div></div>';
  html += '<button class="grid-remove-btn" data-remove-folder="' + escapeHtml(folderName) + '" title="Pura folder delete karein">'
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

// Downloads tab se ek downloaded folder ke andar "ghuso" - agar us folder
// ke andar subfolders bhi thi, to wahi nested structure (folder -> subfolder
// -> file) yahan bhi milti hai, Drive browsing jaisi hi.
var currentDownloadSubPath = []; // abhi kis subfolder ke andar hain (naamon ka chain)

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

// Ek baar upar jaana - subfolder ke andar the to ek level upar, warna
// seedha Downloads tab par. handleBackPress() aur header ka back-chevron
// (goBackFolder) dono isi ko use karte hain.
function exitDownloadFolderLevel() {
  if (currentDownloadSubPath.length > 0) {
    currentDownloadSubPath.pop();
    renderDownloadFolderGrid(currentDownloadFolderName, currentDownloadSubPath);
  } else {
    goDownloads();
  }
}

// Diye gaye subPath (folder-chain) ke exact us level par kya-kya hai -
// us level ki seedhi files, aur us level ke andar ki agli subfolders
// (unke sabhi descendant items ke saath, taaki progress/completion pata chal sake).
function getDownloadFolderLevel(folderName, subPath) {
  var allItems = loadDownloads().filter(function (i) { return i.folderName === folderName; });
  var files = [];
  var subfolderMap = {};
  var subfolderOrder = [];

  allItems.forEach(function (item) {
    var itemPath = item.subPath || [];
    for (var i = 0; i < subPath.length; i++) {
      if (itemPath[i] !== subPath[i]) return; // is subPath ke andar nahi aata
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
    showStateScreen(contentEl, "\uD83D\uDCED", "Khaali",
      "Is folder ki saari files delete ho chuki hain.");
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

// Downloaded folder ke andar ki subfolder ke liye card - poster/📁 icon +
// naam, aur agar us subfolder ke andar sab kuch download nahi hui to ek
// "x/y" badge bhi (kitni files complete hain).
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

// Agar user abhi kisi downloaded folder/subfolder ke andar hai, delete ke
// baad usi level ko taaza data ke saath refresh kar do. Agar wo level ab
// khaali ho chuka hai to ek-ek level upar jaate hain jab tak kuch mile ya
// root tak pahunch jaayein; poora top-folder hi khaali ho gaya ho to
// Downloads tab par wapas bhej dete hain.
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

// Completed download ke liye normal grid-card jaisa hi card (poster + naam),
// bas tap karne par seedha local file play hoti hai aur ek chhota remove
// button diya hota hai delete karne ke liye.
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
      + (item.speed > 0 ? " \u00B7 " + formatBytes(item.speed) + "/s" : " \u00B7 Shuru ho raha hai...");
  } else if (item.status === "completed") {
    subLine = "Download complete" + (item.total > 0 ? " \u00B7 " + formatBytes(item.total) : "");
  } else {
    subLine = "\u26A0\uFE0F " + escapeHtml(item.errorMsg || "Download fail ho gaya");
  }

  var html = '<div class="download-row" data-id="' + item.id + '">'
    + '<div class="d-icon">' + getFileIcon(item.name) + '</div>'
    + '<div class="d-info">'
    + '<div class="d-name">' + escapeHtml(item.name) + '</div>'
    + '<div class="d-sub">' + subLine + '</div>';
  if (item.status === "downloading") {
    html += '<div class="d-progress-track"><div class="d-progress-fill" style="width:' + pct + '%"></div></div>';
  }
  html += '</div>'
    + '<div class="d-actions">';

  if (item.status === "completed") {
    html += '<button class="d-btn" data-act="play" title="Play">'
      + '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
      + '</button>';
  } else if (item.status === "error") {
    html += '<button class="d-btn" data-act="retry" title="Retry">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>'
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

    var retryBtn = row.querySelector('[data-act="retry"]');
    if (retryBtn) {
      retryBtn.addEventListener("click", function () {
        retryDownload(item.id);
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
