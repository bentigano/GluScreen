const REFRESH_INTERVAL = 10; // in seconds
const BRIGHTNESS_STEPS = 20; // Number of brightness steps (max brightness)

const KEY_DEXCOM_USERNAME = "DEXCOM_USERNAME";
const KEY_DEXCOM_PASSWORD = "DEXCOM_PASSWORD";
const KEY_DEXCOM_TOKEN = "DEXCOM_TOKEN";
const KEY_NIGHT_BRIGHTNESS = "NIGHT_BRIGHTNESS";

var lastReadingTime;
var nextReadingTime = 0; // default to some date in the past
var dexcomUsername = "";
var dexcomPassword = "";

function getCurrentTime() {
    const now = new Date();
    let hours = now.getHours();
    const minutes = now.getMinutes().toString().padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12; // Convert 24-hour time to 12-hour format
    return `${hours}:${minutes} ${ampm}`; 
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

async function getAuthToken(forceRefresh) {

    if (forceRefresh || localStorage.getItem(KEY_DEXCOM_TOKEN) == null) {
        
        console.log("Refreshing Dexcom access token");

        const authRequest = {
            accountName: dexcomUsername,
            password: dexcomPassword,
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
            throw new Error(`HTTP Error! Status: ${response.status}`);
        }

        localStorage.setItem(KEY_DEXCOM_TOKEN, await response.json());
        console.log("Dexcom auth token updated");
    }
    return localStorage.getItem(KEY_DEXCOM_TOKEN);
}

async function refreshDexcomReadings() {
    try {
        console.log("Refreshing values from Dexcom");

        await getAuthToken(false);

        const response = await fetch(`https://share1.dexcom.com/ShareWebServices/Services/Publisher/ReadPublisherLatestGlucoseValues?sessionId=${localStorage.getItem(KEY_DEXCOM_TOKEN)}&minutes=1440&maxCount=2`, {
            method: "POST",
            headers: {
                "Accept": "application/json"
            }
        });

        if (!response.ok) {
            if (response.status == 500) {
                try {
                    const errorResponse = await response.json();
                    if (errorResponse.Code == "SessionNotValid") {
                        await getAuthToken(true);
                        return;
                    }
                }
                catch (error) {
                    console.error("Error fetching glucose value:", error);
                    document.getElementById("error").innerText = error;
                }
            } else {
                throw new Error(`HTTP Error! Status: ${response.status}`);
            }
        }

        return await response.json();

    }
    catch (error) {
        console.error("Error fetching glucose value:", error);
        document.getElementById("error").innerText = error;
    }
    return null;
}

async function updateReading() {

    if (dexcomUsername.length < 4 || dexcomPassword.length < 4) {
        document.getElementById("error").innerText = "Missing Dexcom credentials - check Settings.";
        return;
    }

    try {
        // check if it's been more than 5 minutes since our last reading
        if (Date.now() > nextReadingTime) {

            const data = await refreshDexcomReadings();

            lastReadingTime = convertDexcomToDate(data[0].WT);
            nextReadingTime = convertDexcomToDate(data[0].WT) + ((5 * 60 + 15) * 1000);
            console.log(`Next reading should be at ${new Date(nextReadingTime).toString()}`)

            if (data[0].Value > 0) {
                document.getElementById("glucose").innerText = data[0].Value;
            } else {
                document.getElementById("glucose").innerText = "???";
            }

            // update trend
            var trend = data[0].Trend;
            switch (trend) {
                case "DoubleUp":
                    trend = "⇈";
                    break;
                case "SingleUp":
                    trend = "↑";
                    break;
                case "FortyFiveUp":
                    trend = "↗";
                    break;
                case "Flat":
                    trend = "→";
                    break;
                case "FortyFiveDown":
                    trend = "↘";
                    break;
                case "SingleDown":
                    trend = "↓";
                    break;
                case "DoubleDown":
                    trend = "⇊";
                    break;
                default:
                    trend = "&nbsp;&nbsp;&nbsp;";
                    break;
            }
            document.getElementById("arrow").innerHTML = trend;

            // update difference from last number
            var difference = data[0].Value - data[1].Value
            var differenceElement = document.getElementById("difference");
            differenceElement.innerText = difference >= 0 ? `+${difference}` : difference;

        }
        var timeDiff = timeDifference(lastReadingTime);
        if (timeDiff < 1) {
            document.getElementById("last-reading").innerText = "just now"
        } else {
            document.getElementById("last-reading").innerText = `${timeDiff} minutes ago`;
        }

        if (timeDiff > 10) {
            document.getElementById("last-reading").classList.add("hot");
        } else {
            document.getElementById("last-reading").classList.remove("hot");
        }

        document.getElementById("error").innerText = "";
    } catch (error) {
        console.error("Error fetching glucose value:", error);
        document.getElementById("error").innerText = error;
    }
}

async function fetchData() {
    updateReading();
    document.getElementById("time").innerText = getCurrentTime();

    if (!timeIsNight()) {
        setOpacity(BRIGHTNESS_STEPS);
    } else {
        setOpacity(localStorage.getItem(KEY_NIGHT_BRIGHTNESS));
    }
}

function reduceBrightness() {
    var currentBrightness = localStorage.getItem(KEY_NIGHT_BRIGHTNESS);
    if (currentBrightness <= 2) return;
    
    currentBrightness--;
    localStorage.setItem(KEY_NIGHT_BRIGHTNESS, currentBrightness);
    setOpacity(currentBrightness);
}

async function increaseBrightness() {
    var currentBrightness = localStorage.getItem(KEY_NIGHT_BRIGHTNESS);
    if (currentBrightness >= 20) return;

    currentBrightness++;
    localStorage.setItem(KEY_NIGHT_BRIGHTNESS, currentBrightness);
    setOpacity(currentBrightness);
}

function setOpacity(brightnessLevel) {
    opacity = brightnessLevel / BRIGHTNESS_STEPS;
    document.getElementById("main-display").style.opacity = opacity;
}

function launchDexcomStatusPage() {
    window.open('https://status.dexcom.com/', '_blank', 'noopener, noreferrer');
}

function launchGithub() {
    window.open('https://github.com/bentigano/GluScreen', '_blank', 'noopener, noreferrer');
}

function loadSettings() {
    if (localStorage.getItem(KEY_DEXCOM_USERNAME) !== null) {
        $('#dexcom-username').val(atob(localStorage.getItem(KEY_DEXCOM_USERNAME)));
    }
    if (localStorage.getItem(KEY_DEXCOM_PASSWORD) !== null) {
        $('#dexcom-password').val(atob(localStorage.getItem(KEY_DEXCOM_PASSWORD)));
    }
    $('#rangeNightBrightness').val(localStorage.getItem(KEY_NIGHT_BRIGHTNESS));

    initializeSettings();
}

function clearSettings() {
    localStorage.clear();
    loadSettings();
    $('#settingsPage').modal('hide');
}

function saveSettings() {
    localStorage.setItem(KEY_DEXCOM_USERNAME, btoa($('#dexcom-username').val()));
    localStorage.setItem(KEY_DEXCOM_PASSWORD, btoa($('#dexcom-password').val()));
    localStorage.setItem(KEY_NIGHT_BRIGHTNESS, $('#rangeNightBrightness').val());
    initializeSettings();
    $('#settingsPage').modal('hide');
}

function initializeSettings() {
    dexcomUsername = atob(localStorage.getItem(KEY_DEXCOM_USERNAME));
    dexcomPassword = atob(localStorage.getItem(KEY_DEXCOM_PASSWORD));
    
    if (localStorage.getItem(KEY_NIGHT_BRIGHTNESS) === null) {
        localStorage.setItem(KEY_NIGHT_BRIGHTNESS, 20);
    }
    setOpacity(localStorage.getItem(KEY_NIGHT_BRIGHTNESS));
}

// Run immediately, then refresh based on an interval
initializeSettings();
fetchData();
setInterval(fetchData, REFRESH_INTERVAL * 1000);