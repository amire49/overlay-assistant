const api = window.assistant;
const $ = (id) => document.getElementById(id);

let pollTimer = null;

async function init() {
  const info = await api.getLicenseInfo();
  $("device-id").value = info.deviceId;
  if (info.status === "revoked") {
    $("status").textContent = "Access for this device has been revoked by the owner.";
  } else if (info.status === "pending") {
    $("status").textContent = "Request sent. Waiting for owner approval…";
    startPolling();
  } else if (info.status === "unconfigured") {
    $("status").textContent = "License server URL is not configured in this build.";
  }
}

$("copy-id").onclick = async () => {
  await api.copyText($("device-id").value);
  $("copy-id").textContent = "Copied";
  setTimeout(() => ($("copy-id").textContent = "Copy"), 1500);
};

$("req-form").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("name").value.trim();
  if (!name) return;
  $("req-btn").disabled = true;
  $("status").textContent = "Sending access request…";
  try {
    const res = await api.requestLicense(name);
    if (res.status === "approved") {
      $("status").textContent = "Approved! Launching…";
      return;
    }
    if (res.status === "revoked") {
      $("status").textContent = "Access for this device has been revoked by the owner.";
      return;
    }
    $("status").textContent = "Request sent! Waiting for owner approval…";
    startPolling();
  } catch (err) {
    $("status").textContent = err.message.replace(/^.*Error:\s*/, "");
  } finally {
    $("req-btn").disabled = false;
  }
};

async function checkNow() {
  $("check-btn").disabled = true;
  try {
    const res = await api.checkLicense();
    if (res.status === "approved") {
      $("status").textContent = "Approved! Launching…";
      clearInterval(pollTimer);
    } else if (res.status === "revoked") {
      $("status").textContent = "Access for this device has been revoked by the owner.";
      clearInterval(pollTimer);
    } else if (res.status === "pending") {
      $("status").textContent = "Still waiting for owner approval…";
    } else {
      $("status").textContent = "Not requested yet. Enter your name and click Request Access.";
    }
  } catch (err) {
    $("status").textContent = err.message.replace(/^.*Error:\s*/, "");
  } finally {
    $("check-btn").disabled = false;
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(checkNow, 5000);
}

$("check-btn").onclick = checkNow;
init();

