const REFRESH_INTERVAL = 10; // in seconds
const BRIGHTNESS_STEPS = 20; // Number of brightness steps (max brightness)
const FOUR_MINUTES = 4 * 60 * 1000;
const TWO_MINUTES = 2 * 60 * 1000;

const KEY_DEXCOM_USERNAME1 = "DEXCOM_USERNAME";
const KEY_DEXCOM_PASSWORD1 = "DEXCOM_PASSWORD";
const KEY_DEXCOM_TOKEN1 = "DEXCOM_TOKEN";
const KEY_COLOR1 = "COLOR1";

const KEY_DEXCOM_USERNAME2 = "DEXCOM_USERNAME2";
const KEY_DEXCOM_PASSWORD2 = "DEXCOM_PASSWORD2";
const KEY_DEXCOM_TOKEN2 = "DEXCOM_TOKEN2";
const KEY_COLOR2 = "COLOR2";

const KEY_NIGHT_BRIGHTNESS = "NIGHT_BRIGHTNESS";
const KEY_ENABLE_LOGGING = "ENABLE_LOGGING";

var lastReadingTime1;
var nextReadingTime1 = 0; // default to some date in the past
var dexcomUsername1 = "";
var dexcomPassword1 = "";

var lastReadingTime2;
var nextReadingTime2 = 0; // default to some date in the past
var dexcomUsername2 = "";
var dexcomPassword2 = "";

function logError(message) {
    let timestamp = getCurrentTime(true);
    console.error(`${timestamp} - ${message}`);
    $("#tblLog tbody").prepend(`<tr class="table-info"><td>${timestamp}</td><td>${message}</td></tr>`);
    pruneOldTableRows();
}

function logDebug(message) {
    if (localStorage.getItem(KEY_ENABLE_LOGGING)) {
        let timestamp = getCurrentTime(true);
        console.log(`${timestamp} - ${message}`);
        $("#tblLog tbody").prepend(`<tr class="table-info"><td>${timestamp}</td><td>${message}</td></tr>`);
        pruneOldTableRows();
    }
}

// remove old rows from the log table (only allow 100 rows)
function pruneOldTableRows() {
    const maxRows = 100
    var $table = $("#tblLog");
    var $rows = $table.find('tbody tr');

    if ($rows.length > maxRows) {
        var rowsToRemove = $rows.length - maxRows;
        $rows.slice(-rowsToRemove).remove();
    }
}

async function checkInternetConnection() {
    try {
        const response = await fetch("https://clients3.google.com/generate_204", {
            method: "GET",
            mode: "no-cors", // This avoids CORS errors, though response details are limited
            cache: "no-cache"
        });

        // If the fetch didn't throw, we likely have internet
        return true;
    } catch (error) {
        // If the fetch fails, assume no internet
        return false;
    }
}

function getCurrentTime(withSeconds) {
    const now = new Date();
    let hours = now.getHours();
    const minutes = now.getMinutes().toString().padStart(2, "0");
    const seconds = now.getSeconds().toString().padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12; // Convert 24-hour time to 12-hour format
    if (withSeconds) {
        return `${hours}:${minutes}:${seconds} ${ampm}`;
    } else {
        return `${hours}:${minutes} ${ampm}`;
    }
}

function timeIsNight() {
    const now = new Date();
    const hours = now.getHours();
    return hours >= 20 || hours < 7;
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

async function getAuthToken(forceRefresh, follower1) {

    if (!await checkInternetConnection() || !navigator.onLine) {
        let error = "No internet - check connection.";
        logError(error);
        document.getElementById("error1").innerText = document.getElementById("error2").innerText = error;
        return;
    }
    if (forceRefresh || localStorage.getItem(follower1 ? KEY_DEXCOM_TOKEN1 : KEY_DEXCOM_TOKEN2) == null) {

        const whichFollower = follower1 ? "Follower 1" : "Follower 2";

        logDebug(`Refreshing Dexcom access token for ${whichFollower}`);

        const authRequest = {
            accountName: follower1 ? dexcomUsername1 : dexcomUsername2,
            password: follower1 ? dexcomPassword1 : dexcomPassword2,
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
            logError(`Error updating auth token for ${whichFollower}. Dexcom Response: ${response.status}`);
            localStorage.removeItem(follower1 ? KEY_DEXCOM_TOKEN1 : KEY_DEXCOM_TOKEN2);
            return;
        }

        let authToken = await response.json();

        if (authToken == "00000000-0000-0000-0000-000000000000") {
            logError(`Error updating auth token for ${whichFollower}. Invalid auth token received.`);
            localStorage.removeItem(follower1 ? KEY_DEXCOM_TOKEN1 : KEY_DEXCOM_TOKEN2);
            return;
        }

        localStorage.setItem(follower1 ? KEY_DEXCOM_TOKEN1 : KEY_DEXCOM_TOKEN2, authToken);
        logDebug(`Dexcom auth token updated for ${whichFollower}`);
    }
    return localStorage.getItem(follower1 ? KEY_DEXCOM_TOKEN1 : KEY_DEXCOM_TOKEN2);
}

async function refreshDexcomReadings(follower1) {
    try {
        if (!await checkInternetConnection() || !navigator.onLine) {
            let error = "No internet - check connection.";
            logError(error);
            document.getElementById("error1").innerText = document.getElementById("error2").innerText = error;
            return;
        }

        const whichFollower = follower1 ? "Follower 1" : "Follower 2";

        logDebug(`${whichFollower}: Attempting to get updated readings from Dexcom`);

        await getAuthToken(false, follower1);

        if (localStorage.getItem(follower1 ? KEY_DEXCOM_TOKEN1 : KEY_DEXCOM_TOKEN2) === null) {
            let authTokenError = `${whichFollower}: No auth token - check credentials.`;
            logError(authTokenError);
            if (follower1) {
                document.getElementById("error1").innerText = authTokenError;
            } else {
                document.getElementById("error2").innerText = authTokenError;
            }

            return null;
        }

        const response = await fetch(`https://share1.dexcom.com/ShareWebServices/Services/Publisher/ReadPublisherLatestGlucoseValues?sessionId=${localStorage.getItem(follower1 ? KEY_DEXCOM_TOKEN1 : KEY_DEXCOM_TOKEN2)}&minutes=1440&maxCount=4`, {
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
                        await getAuthToken(true, follower1);
                        return;
                    }
                }
                catch (error) {
                    logError(`${whichFollower}: Error fetching glucose value: ${error}`);
                    document.getElementById("error1").innerText = document.getElementById("error2").innerText = error;
                }
            } else {
                logError(`${whichFollower}: Error refreshing Dexcom readings. Dexcom Response: ${response.status}`);
                return;
            }
        }

        return await response.json();

    }
    catch (error) {
        logError(`${whichFollower}: Error fetching glucose value: ${error}`);
        document.getElementById("error1").innerText = document.getElementById("error2").innerText = error;
    }
    return null;
}

function needToCheckFollower2() {
    if (dexcomUsername2 == null || dexcomUsername2.length < 4 || dexcomPassword2 == null || dexcomPassword2.length < 4) {
        return false;
    }
    return true;
}

async function updateReading() {

    if (dexcomUsername1 == null || dexcomUsername1.length < 4 || dexcomPassword1 == null || dexcomPassword1.length < 4) {
        logError("Follower 1: Missing Dexcom credentials - check Settings.");
        document.getElementById("error").innerText = "Missing Dexcom credentials - check Settings.";
        return;
    }

    //#region Update Follower 1
    try {
        // check if it's been more than 5 minutes since our last reading
        if (Date.now() > nextReadingTime1) {

            const data = await refreshDexcomReadings(true);

            if (data === null || data === undefined) {
                logError("Follower 1: No data received from Dexcom - see previous errors.");
                return;
            } else {
                logDebug(JSON.stringify(data));
            }

            lastReadingTime1 = calculateMostRecentReadingTime(data);

            // if the last reading from Dexcom is more than 5m30s seconds old, wait 5 minutes from now
            if (Date.now() > lastReadingTime1 + ((5 * 60) + 30) * 1000) {
                logDebug(`Follower 1: Last reading from Dexcom is stale: ${new Date(lastReadingTime1).toString()}`)
                nextReadingTime1 = Date.now() + ((5 * 60) * 1000);
                logDebug(`Follower 1: Next reading should be at ${new Date(nextReadingTime1).toString()}`)
            } else {
                nextReadingTime1 = lastReadingTime1 + ((5 * 60 + 15) * 1000);
                logDebug(`Follower 1: Next reading should be at ${new Date(nextReadingTime1).toString()}`)
            }

            if (data[0].Value > 0) {
                document.getElementById("glucose1").innerText = data[0].Value;
                document.getElementById("mgdl1").innerText = "mg/dL"
            } else {
                document.getElementById("glucose1").innerText = "???";
                document.getElementById("mgdl1").innerText = ""
            }

            // update trend
            var trend = data[0].Trend;
            switch (trend) {
                case "DoubleUp":
                    trend = "⇈\uFE0E";
                    break;
                case "SingleUp":
                    trend = "↑\uFE0E";
                    break;
                case "FortyFiveUp":
                    trend = "↗\uFE0E";
                    break;
                case "Flat":
                    trend = "→\uFE0E";
                    break;
                case "FortyFiveDown":
                    trend = "↘\uFE0E";
                    break;
                case "SingleDown":
                    trend = "↓\uFE0E";
                    break;
                case "DoubleDown":
                    trend = "⇊\uFE0E";
                    break;
                default:
                    trend = "&nbsp;&nbsp;&nbsp;";
                    break;
            }
            document.getElementById("arrow1").innerHTML = trend;

            // update difference from last number
            var difference = data[0].Value - calculateLastReading(data);
            var differenceElement = document.getElementById("difference1");
            differenceElement.innerText = difference >= 0 ? `+${difference}` : difference;

        } // end try
        var timeDiff = timeDifference(lastReadingTime1);
        if (timeDiff < 1) {
            document.getElementById("last-reading1").innerText = "just now"
        } else {
            document.getElementById("last-reading1").innerText = `${timeDiff} minutes ago`;
        }

        if (timeDiff > 10) {
            document.getElementById("last-reading1").classList.add("hot");
        } else {
            document.getElementById("last-reading1").classList.remove("hot");
        }

        document.getElementById("error1").innerText = "";
    } catch (error) {
        logError(`Follower 1: Error fetching glucose value: ${error}`);
        document.getElementById("error1").innerText = error;
    }
    //#endregion Update Follower 1

    //#region Update Follower 2
    if (needToCheckFollower2()) {
        try {
            // check if it's been more than 5 minutes since our last reading
            if (Date.now() > nextReadingTime2) {

                const data = await refreshDexcomReadings(false);

                if (data === null || data === undefined) {
                    logError("Follower 2: No data received from Dexcom - see previous errors.");
                    return;
                } else {
                    logDebug(JSON.stringify(data));
                }

                lastReadingTime2 = calculateMostRecentReadingTime(data);

                // if the last reading from Dexcom is more than 5m30s seconds old, wait 5 minutes from now
                if (Date.now() > lastReadingTime2 + ((5 * 60) + 30) * 1000) {
                    logDebug(`Follower 2: Last reading from Dexcom is stale: ${new Date(lastReadingTime2).toString()}`)
                    nextReadingTime2 = Date.now() + ((5 * 60) * 1000);
                    logDebug(`Follower 2: Next reading should be at ${new Date(nextReadingTime2).toString()}`)
                } else {
                    nextReadingTime2 = lastReadingTime2 + ((5 * 60 + 15) * 1000);
                    logDebug(`Follower 2: Next reading should be at ${new Date(nextReadingTime2).toString()}`)
                }

                if (data[0].Value > 0) {
                    document.getElementById("glucose2").innerText = data[0].Value;
                    document.getElementById("mgdl2").innerText = "mg/dL"
                } else {
                    document.getElementById("glucose2").innerText = "???";
                    document.getElementById("mgdl2").innerText = ""
                }

                // update trend
                var trend = data[0].Trend;
                switch (trend) {
                    case "DoubleUp":
                        trend = "⇈\uFE0E";
                        break;
                    case "SingleUp":
                        trend = "↑\uFE0E";
                        break;
                    case "FortyFiveUp":
                        trend = "↗\uFE0E";
                        break;
                    case "Flat":
                        trend = "→\uFE0E";
                        break;
                    case "FortyFiveDown":
                        trend = "↘\uFE0E";
                        break;
                    case "SingleDown":
                        trend = "↓\uFE0E";
                        break;
                    case "DoubleDown":
                        trend = "⇊\uFE0E";
                        break;
                    default:
                        trend = "&nbsp;&nbsp;&nbsp;";
                        break;
                }
                document.getElementById("arrow2").innerHTML = trend;

                // update difference from last number
                var difference = data[0].Value - calculateLastReading(data);
                var differenceElement = document.getElementById("difference2");
                differenceElement.innerText = difference >= 0 ? `+${difference}` : difference;

            } // end try
            var timeDiff = timeDifference(lastReadingTime2);
            if (timeDiff < 1) {
                document.getElementById("last-reading2").innerText = "just now"
            } else {
                document.getElementById("last-reading2").innerText = `${timeDiff} minutes ago`;
            }

            if (timeDiff > 10) {
                document.getElementById("last-reading2").classList.add("hot");
            } else {
                document.getElementById("last-reading2").classList.remove("hot");
            }

            document.getElementById("error2").innerText = "";
        } catch (error) {
            logError(`Follower 2: Error fetching glucose value: ${error}`);
            document.getElementById("error2").innerText = error;
        }
    } // end if we need to update follower 2
    //#endregion Update Follower 2
}

async function fetchData() {
    updateReading();
    document.getElementById("time").innerText = getCurrentTime(false);

    if (!timeIsNight()) {
        setOpacity(BRIGHTNESS_STEPS); // set max brightness during the day
    } else {
        setOpacity(localStorage.getItem(KEY_NIGHT_BRIGHTNESS));
    }

    document.getElementById("content1").style.color = localStorage.getItem(KEY_COLOR1);
    document.getElementById("content2").style.color = localStorage.getItem(KEY_COLOR2);
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
    opacity = brightnessLevel / BRIGHTNESS_STEPS;
    document.getElementById("main-display").style.opacity = opacity;
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
    if (localStorage.getItem(KEY_DEXCOM_USERNAME1) !== null) {
        $('#dexcom-username1').val(atob(localStorage.getItem(KEY_DEXCOM_USERNAME1)));
    }
    if (localStorage.getItem(KEY_DEXCOM_PASSWORD1) !== null) {
        $('#dexcom-password1').val(atob(localStorage.getItem(KEY_DEXCOM_PASSWORD1)));
    }
    if (localStorage.getItem(KEY_DEXCOM_USERNAME2) !== null) {
        $('#dexcom-username2').val(atob(localStorage.getItem(KEY_DEXCOM_USERNAME2)));
    }
    if (localStorage.getItem(KEY_DEXCOM_PASSWORD2) !== null) {
        $('#dexcom-password2').val(atob(localStorage.getItem(KEY_DEXCOM_PASSWORD2)));
    }
    $('#rangeNightBrightness').val(localStorage.getItem(KEY_NIGHT_BRIGHTNESS));
    $('#colorPicker1').val(localStorage.getItem(KEY_COLOR1));
    $('#colorPicker2').val(localStorage.getItem(KEY_COLOR2));

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
    localStorage.setItem(KEY_DEXCOM_USERNAME1, btoa($('#dexcom-username1').val()));
    localStorage.setItem(KEY_DEXCOM_PASSWORD1, btoa($('#dexcom-password1').val()));
    localStorage.removeItem(KEY_DEXCOM_TOKEN1); // clear the auth token when username/password is being updated
    localStorage.setItem(KEY_DEXCOM_USERNAME2, btoa($('#dexcom-username2').val()));
    localStorage.setItem(KEY_DEXCOM_PASSWORD2, btoa($('#dexcom-password2').val()));
    localStorage.removeItem(KEY_DEXCOM_TOKEN2); // clear the auth token when username/password is being updated
    localStorage.setItem(KEY_NIGHT_BRIGHTNESS, $('#rangeNightBrightness').val());
    localStorage.setItem(KEY_ENABLE_LOGGING, $('#chkEnableLogging').is(":checked"));
    localStorage.setItem(KEY_COLOR1, $('#colorPicker1').val());
    localStorage.setItem(KEY_COLOR2, $('#colorPicker2').val());
    logDebug("Settings saved");
    initializeSettings();
    nextReadingTime1 = nextReadingTime2 = 0; // this will force an update
    fetchData();
    $('#settingsPage').modal('hide');
}

function initializeSettings() {
    logDebug("Initializing settings");
    dexcomUsername1 = atob(localStorage.getItem(KEY_DEXCOM_USERNAME1));
    dexcomPassword1 = atob(localStorage.getItem(KEY_DEXCOM_PASSWORD1));
    dexcomUsername2 = atob(localStorage.getItem(KEY_DEXCOM_USERNAME2));
    dexcomPassword2 = atob(localStorage.getItem(KEY_DEXCOM_PASSWORD2));

    if (localStorage.getItem(KEY_DEXCOM_USERNAME1) == null) {
        dexcomUsername1 = null;
    }

    if (localStorage.getItem(KEY_DEXCOM_PASSWORD1) == null) {
        dexcomPassword1 = null;
    }

    if (localStorage.getItem(KEY_DEXCOM_USERNAME2) == null) {
        dexcomUsername2 = null;
    }

    if (localStorage.getItem(KEY_DEXCOM_PASSWORD2) == null) {
        dexcomPassword2 = null;
    }

    if (dexcomUsername1 == null || dexcomPassword1 == null) {
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
    if (localStorage.getItem(KEY_COLOR1) === null) {
        logDebug("Color 1 not set. Defaulting to #FFFFFF");
        localStorage.setItem(KEY_COLOR1, "#FFFFFF");
    }
    if (localStorage.getItem(KEY_COLOR2) === null) {
        logDebug("Color 2 not set. Defaulting to #BBFAAC");
        localStorage.setItem(KEY_COLOR2, "#BBFAAC");
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