
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
  pauseHeroCarousel();
  viewMode = "movies";
  appRoot.classList.remove("browse-mode");
  setActiveNav(navMovies);
  homeViewEl.classList.add("hidden");
  downloadsViewEl.classList.add("hidden");
  contentEl.classList.remove("hidden");
  loadCategoryFolders(["Bollywood", "Hollywood", "Fast and Furious", "Mission Impossible",], "Movie", true, MOVIE_TAB_EXTRA_PATHS);
}

var WEB_TAB_EXTRA_PATHS = [
  
];


function goWebSeries() {
  closeSearch();
  pauseHeroCarousel();
  viewMode = "webseries";
  appRoot.classList.remove("browse-mode");
  setActiveNav(navWebSeries);
  homeViewEl.classList.add("hidden");
  downloadsViewEl.classList.add("hidden");
  contentEl.classList.remove("hidden");
  loadCategoryFolders(["Web Series"], "Web Series", true, WEB_TAB_EXTRA_PATHS);
}
