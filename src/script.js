const REFRESH_INTERVAL = 10; // in seconds
const BRIGHTNESS_STEPS = 20; // Number of brightness steps (max brightness)
const FOUR_MINUTES = 4 * 60 * 1000;
const TWO_MINUTES = 2 * 60 * 1000;

const KEY_NIGHT_BRIGHTNESS = "NIGHT_BRIGHTNESS";
const KEY_ENABLE_LOGGING = "ENABLE_LOGGING";

const TREND_MAP = {
    DoubleUp: "⇈︎\uFE0E",
    SingleUp: "↑︎\uFE0E",
    FortyFiveUp: "↗︎\uFE0E",
    Flat: "→︎\uFE0E",
    FortyFiveDown: "↘︎\uFE0E",
    SingleDown: "↓︎\uFE0E",
    DoubleDown: "⇊︎\uFE0E"
};

const followers = {
    1: {
        lastReadingTime: 0, nextReadingTime: 0, dexcomUsername: "", dexcomPassword: "",
        keyUsername: "DEXCOM_USERNAME", keyPassword: "DEXCOM_PASSWORD", keyToken: "DEXCOM_TOKEN", keyColor: "COLOR1"
    },
    2: {
        lastReadingTime: 0, nextReadingTime: 0, dexcomUsername: "", dexcomPassword: "",
        keyUsername: "DEXCOM_USERNAME2", keyPassword: "DEXCOM_PASSWORD2", keyToken: "DEXCOM_TOKEN2", keyColor: "COLOR2"
    }
};

/* =========================
   Logging
========================= */
function log(type, msg) {
    if (type === "debug" && localStorage.getItem(KEYS.LOGGING) !== "true") return;

    const ts = new Date().toLocaleTimeString();
    console[type](`${ts} - ${msg}`);

    $("#tblLog tbody")
        .prepend(`<tr class="table-info"><td>${ts}</td><td>${msg}</td></tr>`)
        .find("tr:gt(99)").remove();
    // remove old rows from the log table (only allow 100 rows)
}

const logDebug = msg => log("log", msg);
const logError = msg => log("error", msg);

async function checkInternetConnection() {
    try {
        await fetch("https://clients3.google.com/generate_204", {
            method: "GET",
            mode: "no-cors", // This avoids CORS errors, though response details are limited
            cache: "no-cache"
        });

        // If the fetch didn't throw, we likely have internet
        return true;
    } catch {
        // If the fetch fails, assume no internet
        return false;
    }
}

function isNight() {
    const h = new Date().getHours();
    return h >= 20 || h < 7;
}

function timeDifference(timeString) {
    const givenTime = new Date(timeString);
    const currentTime = new Date();

    // Difference in milliseconds
    const diffMs = currentTime - givenTime;

    // Convert to minutes
    const diffMinutes = Math.floor(diffMs / (1000 * 60));

    return diffMinutes;
}

function convertDexcomToDate(timeString) {
    const match = timeString.match(/Date\((\d+)\)/);
    if (!match) {
        throw new Error("Invalid date format");
    }

    return parseInt(match[1]);
}

// grab the last reading that is more than 4 minutes older than the most recent reading
function calculateLastReading(data) {
    const parsed = data.map(d => ({
        ...d,
        WTms: parseInt(d.WT.match(/\d+/)[0])
    }));

    // sort oldest to newest
    parsed.sort((a, b) => b.WTms - a.WTms);

    // get the newest reading time
    const newest = parsed[0].WTms;

    // find the next WT more than 4 minutes (240,000 ms) older

    const nextOlder = parsed.find(d => newest - d.WTms > FOUR_MINUTES);

    return nextOlder.Value;
}

// grab the newest reading unless the second reading is withing 2 minutes of the newest (grab the second instead)
function calculateMostRecentReadingTime(data) {
    const parsed = data.map(d => ({
        ...d,
        WTms: parseInt(d.WT.match(/\d+/)[0])
    }));

    // sort oldest to newest
    parsed.sort((a, b) => b.WTms - a.WTms);

    // find the most recent reading, or the reading within 2 minutes before that
    // this resolves issues where more than 1 device is reporting data (such as phone and watch)
    if (parsed.length > 1 && parsed[0].WTms - parsed[1].WTms < TWO_MINUTES)
        return parsed[1].WTms;
    else
        return parsed[0].WTms;
}

async function getAuthToken(forceRefresh, whichFollower) {

    if (!await checkInternetConnection() || !navigator.onLine) {
        let error = "No internet - check connection.";
        logError(error);
        document.getElementById("error1").innerText = document.getElementById("error2").innerText = error;
        return;
    }
    if (forceRefresh || localStorage.getItem(followers[whichFollower].keyToken) == null) {


        logDebug(`Refreshing Dexcom access token for Follower ${whichFollower}`);

        const authRequest = {
            accountName: followers[whichFollower].dexcomUsername,
            password: followers[whichFollower].dexcomPassword,
            applicationId: "d89443d2-327c-4a6f-89e5-496bbb0317db"
        }

        const response = await fetch("https://share1.dexcom.com/ShareWebServices/Services/General/LoginPublisherAccountByName", {
            method: "POST",
            headers: {
                "User-Agent": "Dexcom Share/3.0.2.11 CFNetwork/711.2.23 Darwin/14.0.0",
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify(authRequest)
        });

        if (!response.ok) {
            logError(`Error updating auth token for Follower ${whichFollower}. Dexcom Response: ${response.status}`);
            localStorage.removeItem(followers[whichFollower].keyToken);
            return;
        }

        let authToken = await response.json();

        if (authToken == "00000000-0000-0000-0000-000000000000") {
            logError(`Error updating auth token for Follower ${whichFollower}. Invalid auth token received.`);
            localStorage.removeItem(followers[whichFollower].keyToken);
            return;
        }

        localStorage.setItem(followers[whichFollower].keyToken, authToken);
        logDebug(`Dexcom auth token updated for Follower ${whichFollower}`);
    }
    return localStorage.getItem(followers[whichFollower].keyToken);
}

async function refreshDexcomReadings(whichFollower) {
    try {
        if (!await checkInternetConnection() || !navigator.onLine) {
            let error = "No internet - check connection.";
            logError(error);
            document.getElementById("error1").innerText = document.getElementById("error2").innerText = error;
            return;
        }

        logDebug(`Follower ${whichFollower}: Attempting to get updated readings from Dexcom`);

        await getAuthToken(false, whichFollower);

        if (localStorage.getItem(followers[whichFollower].keyToken) === null) {
            let authTokenError = `${whichFollower}: No auth token - check credentials.`;
            logError(authTokenError);
            document.getElementById(`error${whichFollower}`).innerText = authTokenError;
            return null;
        }

        const response = await fetch(`https://share1.dexcom.com/ShareWebServices/Services/Publisher/ReadPublisherLatestGlucoseValues?sessionId=${localStorage.getItem(followers[whichFollower].keyToken)}&minutes=1440&maxCount=4`, {
            method: "POST",
            headers: {
                "Accept": "application/json"
            }
        });

        if (!response.ok) {
            if (response.status == 500) {
                try {
                    const errorResponse = await response.json();
                    if (errorResponse.Code == "SessionNotValid" || errorResponse.Code == "SessionIdNotFound") {
                        await getAuthToken(true, whichFollower);
                        return;
                    }
                }
                catch (error) {
                    logError(`Follower ${whichFollower}: Error fetching glucose value: ${error}`);
                    document.getElementById("error1").innerText = document.getElementById("error2").innerText = error;
                }
            } else {
                logError(`Follower ${whichFollower}: Error refreshing Dexcom readings. Dexcom Response: ${response.status}`);
                return;
            }
        }

        return await response.json();

    }
    catch (error) {
        logError(`Follower ${whichFollower}: Error fetching glucose value: ${error}`);
        document.getElementById("error1").innerText = document.getElementById("error2").innerText = error;
    }
    return null;
}

function needToCheckFollower2() {
    if (followers[2].dexcomUsername == null || followers[2].dexcomUsername.length < 4 ||
        followers[2].dexcomPassword == null || followers[2].dexcomPassword.length < 4) {
        return false;
    }
    return true;
}

async function updateFollower(whichFollower) {
    try {
        // check if it's been more than 5 minutes since our last reading
        if (Date.now() > followers[whichFollower].nextReadingTime) {

            const data = await refreshDexcomReadings(whichFollower);

            if (data === null || data === undefined) {
                logError(`Follower ${whichFollower}: No data received from Dexcom - see previous errors.`);
                return;
            } else {
                logDebug(JSON.stringify(data));
            }

            followers[whichFollower].lastReadingTime = calculateMostRecentReadingTime(data);

            // if the last reading from Dexcom is more than 5m30s seconds old, wait 5 minutes from now
            if (Date.now() > followers[whichFollower].lastReadingTime + ((5 * 60) + 30) * 1000) {
                logDebug(`Follower ${whichFollower}: Last reading from Dexcom is stale: ${new Date(followers[whichFollower].lastReadingTime).toString()}`)
                followers[whichFollower].nextReadingTime = Date.now() + ((5 * 60) * 1000);
                logDebug(`Follower ${whichFollower}: Next reading should be at ${new Date(followers[whichFollower].nextReadingTime).toString()}`)
            } else {
                followers[whichFollower].nextReadingTime = followers[whichFollower].lastReadingTime + ((5 * 60 + 15) * 1000);
                logDebug(`Follower ${whichFollower}: Next reading should be at ${new Date(followers[whichFollower].nextReadingTime).toString()}`)
            }

            if (data[0].Value > 0) {
                document.getElementById(`glucose${whichFollower}`).innerText = data[0].Value;
                document.getElementById(`mgdl${whichFollower}`).innerText = "mg/dL"
            } else {
                document.getElementById(`glucose${whichFollower}`).innerText = "???";
                document.getElementById(`mgdl${whichFollower}`).innerText = ""
            }

            // update trend
            document.getElementById(`arrow${whichFollower}`).innerHTML = TREND_MAP[data[0].Trend] || "&nbsp;";

            // update difference from last number
            var difference = data[0].Value - calculateLastReading(data);
            var differenceElement = document.getElementById(`difference${whichFollower}`);
            differenceElement.innerText = difference >= 0 ? `+${difference}` : difference;

        } // end try
        var timeDiff = timeDifference(followers[whichFollower].lastReadingTime);
        if (timeDiff < 1) {
            document.getElementById(`last-reading${whichFollower}`).innerText = "just now"
        } else {
            document.getElementById(`last-reading${whichFollower}`).innerText = `${timeDiff} minutes ago`;
        }

        if (timeDiff > 10) {
            document.getElementById(`last-reading${whichFollower}`).classList.add("hot");
        } else {
            document.getElementById(`last-reading${whichFollower}`).classList.remove("hot");
        }

        document.getElementById(`error${whichFollower}`).innerText = "";
    } catch (error) {
        logError(`Follower ${whichFollower}: Error fetching glucose value: ${error}`);
        document.getElementById(`error${whichFollower}`).innerText = error;
    }
}

async function updateReadings() {

    if (followers[1].dexcomUsername == null || followers[1].dexcomUsername.length < 4 || followers[1].dexcomPassword == null || followers[1].dexcomPassword.length < 4) {
        logError("Follower 1: Missing Dexcom credentials - check Settings.");
        document.getElementById("error").innerText = "Missing Dexcom credentials - check Settings.";
        return;
    }

    //#region Update Follower 1

    updateFollower(1);

    //#endregion Update Follower 1

    //#region Update Follower 2
    if (needToCheckFollower2()) {
        updateFollower(2);
    } // end if we need to update follower 2
    //#endregion Update Follower 2
}

async function fetchData() {
    updateReadings();
    document.getElementById("time").innerText = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

    if (!isNight()) {
        setOpacity(BRIGHTNESS_STEPS); // set max brightness during the day
    } else {
        setOpacity(localStorage.getItem(KEY_NIGHT_BRIGHTNESS));
    }

    document.getElementById("content1").style.color = localStorage.getItem(followers[1].keyColor);
    document.getElementById("content2").style.color = localStorage.getItem(followers[2].keyColor);
}

function reduceBrightness() {
    var currentBrightness = localStorage.getItem(KEY_NIGHT_BRIGHTNESS);
    if (currentBrightness <= 2) return;

    currentBrightness--;
    logDebug(`Brightness reduced to ${(currentBrightness / BRIGHTNESS_STEPS) * 100}`);
    localStorage.setItem(KEY_NIGHT_BRIGHTNESS, currentBrightness);
    setOpacity(currentBrightness);
}

async function increaseBrightness() {
    var currentBrightness = localStorage.getItem(KEY_NIGHT_BRIGHTNESS);
    if (currentBrightness >= 20) return;

    currentBrightness++;
    logDebug(`Brightness increased to ${(currentBrightness / BRIGHTNESS_STEPS) * 100}`);
    localStorage.setItem(KEY_NIGHT_BRIGHTNESS, currentBrightness);
    setOpacity(currentBrightness);
}

function setOpacity(brightnessLevel) {
    document.getElementById("main-display").style.opacity = brightnessLevel / BRIGHTNESS_STEPS;
}

function launchDexcomStatusPage() {
    logDebug("Launching Dexcom Status Page link");
    window.open('https://status.dexcom.com/', '_blank', 'noopener, noreferrer');
}

function launchGithub() {
    logDebug("Launching Github link");
    window.open('https://github.com/bentigano/GluScreen', '_blank', 'noopener, noreferrer');
}

function loadSettings() {
    if (localStorage.getItem(followers[1].keyUsername) !== null) {
        $('#dexcom-username1').val(atob(localStorage.getItem(followers[1].keyUsername)));
    }
    if (localStorage.getItem(followers[1].keyPassword) !== null) {
        $('#dexcom-password1').val(atob(localStorage.getItem(followers[1].keyPassword)));
    }
    if (localStorage.getItem(followers[2].keyUsername) !== null) {
        $('#dexcom-username2').val(atob(localStorage.getItem(followers[2].keyUsername)));
    }
    if (localStorage.getItem(followers[2].keyPassword) !== null) {
        $('#dexcom-password2').val(atob(localStorage.getItem(followers[2].keyPassword)));
    }
    $('#rangeNightBrightness').val(localStorage.getItem(KEY_NIGHT_BRIGHTNESS));
    $('#colorPicker1').val(localStorage.getItem(followers[1].keyColor));
    $('#colorPicker2').val(localStorage.getItem(followers[2].keyColor));

    if (localStorage.getItem(KEY_ENABLE_LOGGING) == "true") {
        $('#chkEnableLogging').prop('checked', true);
    }

    initializeSettings();
}

function clearSettings() {
    localStorage.clear();
    logDebug("Settings cleared");
    loadSettings();
    $('#settingsPage').modal('hide');
}

function saveSettings() {
    localStorage.setItem(followers[1].keyUsername, btoa($('#dexcom-username1').val()));
    localStorage.setItem(followers[1].keyPassword, btoa($('#dexcom-password1').val()));
    localStorage.removeItem(followers[1].keyToken); // clear the auth token when username/password is being updated
    localStorage.setItem(followers[2].keyUsername, btoa($('#dexcom-username2').val()));
    localStorage.setItem(followers[2].keyPassword, btoa($('#dexcom-password2').val()));
    localStorage.removeItem(followers[2].keyToken); // clear the auth token when username/password is being updated
    localStorage.setItem(KEY_NIGHT_BRIGHTNESS, $('#rangeNightBrightness').val());
    localStorage.setItem(KEY_ENABLE_LOGGING, $('#chkEnableLogging').is(":checked"));
    localStorage.setItem(followers[1].keyColor, $('#colorPicker1').val());
    localStorage.setItem(followers[2].keyColor, $('#colorPicker2').val());
    logDebug("Settings saved");
    initializeSettings();
    followers[1].nextReadingTime = followers[2].nextReadingTime = 0; // this will force an update
    fetchData();
    $('#settingsPage').modal('hide');
}

function initializeSettings() {
    logDebug("Initializing settings");
    followers[1].dexcomUsername = atob(localStorage.getItem(followers[1].keyUsername));
    followers[1].dexcomPassword = atob(localStorage.getItem(followers[1].keyPassword));
    followers[2].dexcomUsername = atob(localStorage.getItem(followers[2].keyUsername));
    followers[2].dexcomPassword = atob(localStorage.getItem(followers[2].keyPassword));

    if (localStorage.getItem(followers[1].keyUsername) == null) {
        followers[1].dexcomUsername = null;
    }

    if (localStorage.getItem(followers[1].keyPassword) == null) {
        followers[1].dexcomPassword = null;
    }

    if (localStorage.getItem(followers[2].keyUsername) == null) {
        followers[2].dexcomUsername = null;
    }

    if (localStorage.getItem(followers[2].keyPassword) == null) {
        followers[2].dexcomPassword = null;
    }

    if (followers[1].dexcomUsername == null || followers[1].dexcomPassword == null) {
        $('#welcomePage').modal('show');
    }

    if (localStorage.getItem(KEY_NIGHT_BRIGHTNESS) === null) {
        logDebug("Brightness setting not set. Defaulting to 100%");
        localStorage.setItem(KEY_NIGHT_BRIGHTNESS, 20);
    }
    if (localStorage.getItem(KEY_ENABLE_LOGGING) === null) {
        logDebug("Logging setting not set. Defaulting to false");
        localStorage.setItem(KEY_ENABLE_LOGGING, false);
    }
    if (localStorage.getItem(followers[1].keyColor) === null) {
        logDebug("Color 1 not set. Defaulting to #FFFFFF");
        localStorage.setItem(followers[1].keyColor, "#FFFFFF");
    }
    if (localStorage.getItem(followers[2].keyColor) === null) {
        logDebug("Color 2 not set. Defaulting to #BBFAAC");
        localStorage.setItem(followers[2].keyColor, "#BBFAAC");
    }
    setOpacity(localStorage.getItem(KEY_NIGHT_BRIGHTNESS));
}

// Run immediately, then refresh based on an interval
initializeSettings();
fetchData();
setInterval(fetchData, REFRESH_INTERVAL * 1000);

// Alternate display visibility for multiple followers:
const follower1 = document.getElementById("follower1");
const follower2 = document.getElementById("follower2");

let showFirst = true;

setInterval(() => {
    if (showFirst || needToCheckFollower2() == false) {
        follower1.style.display = "block";
        follower2.style.display = "none";
    } else {
        follower1.style.display = "none";
        follower2.style.display = "block";
    }
    showFirst = !showFirst;
}, 4000);

// daily refresh of page (to get new features, etc.)
(function scheduleDailyReload(targetHour, targetMinute) {
    function getNextReloadTime() {
        const now = new Date();
        const next = new Date();

        next.setHours(targetHour, targetMinute, 0, 0);

        // If we've already passed today's target time, schedule for tomorrow
        if (now >= next) {
            next.setDate(next.getDate() + 1);
        }

        return next - now; // milliseconds until reload
    }

    const delay = getNextReloadTime();

    logDebug("Next reload in", Math.round(delay / 1000 / 60), "minutes");

    setTimeout(() => {
        // Force reload from server (bypass cache)
        window.location.reload(true);
    }, delay);

})(3, 0); // <-- reload page at 3:00am (local browser time)