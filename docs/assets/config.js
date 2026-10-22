// Website settings. See section 3 of the README.
window.RIG_CONFIG = {
  owner: "adamslab-gibert",          // GitHub user or organisation that owns the repository
  repo: "metamaterial-rig",          // repository name (the one holding .github/ and results/)
  branch: "main",                    // branch the lab agent commits results to
  labName: "ADAMS (Advanced Dynamics and MechanicS Lab)",
  // YouTube channel that streams the rig camera. Leave "" to show a placeholder instead.
  youtubeChannelId: "UCLDXemaB9-efGT0GIh9KtyQ",
  // DOI of an archived release of the data set (e.g. Zenodo), shown under the download button. Leave "" to hide.
  datasetDoi: "",
  // Live status (optional, free Firebase Realtime Database): the database URL, e.g.
  // "https://metamaterial-rig-default-rtdb.firebaseio.com". Leave "" to use only GitHub's status request.
  liveStatusUrl: "https://metamaterial-rig-default-rtdb.firebaseio.com",
  // With the live status: the machine counts as offline when no heartbeat has arrived for this many seconds.
  liveOfflineSeconds: 20,
  // Without it (GitHub status only): offline when the status has not been refreshed for this many minutes.
  offlineAfterMinutes: 6,
  // How often the page refreshes status and queue (seconds). One GitHub API call per refresh.
  refreshSeconds: 90
};
