// Site settings. Edit these after you create the repository.
window.RIG_CONFIG = {
  owner: "adamslab-gibert",          // GitHub user or organisation that owns the repository
  repo: "metamaterial-rig",          // repository name (the one holding .github/ and results/)
  branch: "main",                    // branch the lab agent commits results to
  labName: "Adams Lab",
  // YouTube channel that streams the rig camera. Leave "" to show a placeholder instead.
  youtubeChannelId: "",
  // Dataset download (Zenodo or GitHub Release) and its DOI. Leave "" to hide.
  datasetUrl: "",
  datasetDoi: "",
  // The machine counts as offline when its status has not been refreshed for this many minutes.
  offlineAfterMinutes: 6,
  // How often the page refreshes status and queue (seconds). One GitHub API call per refresh.
  refreshSeconds: 90
};
