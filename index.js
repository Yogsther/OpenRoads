const fs = require("file-system")
const rp = require("request-promise")
const jsdom = require("jsdom");
const nodemailer = require("nodemailer");
const md5 = require("md5")

const LOG_NAME = "LOG_" + Date.now() + ".txt"
var logs = ""

const {
    JSDOM
} = jsdom;

var id_increment = 0;

const LIST_URL = "http://www.hertzfreerider.se/unauth/list_transport_offer.aspx"
const STATION_URL = "http://www.hertzfreerider.se/unauth/stationInfo.aspx?stationId="

var trips = []
var road_trips = []

var stations = {}

if (fs.existsSync("config.json")) {
    var config = JSON.parse(fs.readFileSync("config.json", "utf8"))
} else {
    config = {
        "minute_interval": 60,
        "clients": ["youremail@test.com"],
        "gmail": {
            "username": "",
            "password": ""
        }
    }
    fs.writeFileSync("config.json", JSON.stringify(config, null, 4))
}

if (fs.existsSync("stations.json")) {
    stations = fs.readFileSync("stations.json")
    stations = JSON.parse(stations)
}

function save() {
    fs.writeFileSync("stations.json", JSON.stringify(stations, null, 4))
}


// Updates the list of avalible rides
function download_list() {
    return new Promise((resolve, reject) => {
        log("Updating list...")
        rp(LIST_URL).then(html => {
            let dom = new JSDOM(html)

            let table = dom.window.document.getElementsByClassName("highlight")[0].parentElement;

            var old_trips = JSON.parse(JSON.stringify(trips))

            if (table) trips = []
            else {
                log("No trips found, this is unusual.")
                return
            }

            log("Found " + table.getElementsByClassName("highlight").length + " trips.")

            for (let i = 0; i < table.childElementCount; i++) {
                var child = table.children[i]
                if (!child.classList.contains("highlight")) continue

                let trip = {
                    id: id_increment++
                }

                let destinations = child.getElementsByClassName("offer_header")[0].children;
                let trip_info = table.children[i + 1].children[0].children

                trip.destinations = {
                    from: {
                        name: destinations[0].textContent,
                        id: destinations[0].href.split("=")[1]
                    },
                    to: {
                        name: destinations[1].textContent,
                        id: destinations[1].href.split("=")[1]
                    }
                }

                trip.dates = {
                    from: new Date(trip_info[0].textContent),
                    to: new Date(trip_info[1].textContent)
                }

                trip.car = trip_info[3].textContent
                trip.signature = md5(JSON.stringify(trip))

                update_station(trip.destinations.from)
                update_station(trip.destinations.to)

                trips.push(trip)
            }

            for (var trip of trips) {
                var data = old_trips.filter(obj => {
                    return obj["signature"] != trip.signature
                })
                if (data.length == 0) {
                    log("Trip added: " + trip.destinations.from.name + " > " + trip.destinations.to.name + " (" + trip.car + ")")
                }
            }

            for (var trip of old_trips) {
                var data = trips.filter(obj => {
                    return obj["signature"] != trip.signature
                })
                if (data.length == 0) {
                    log("Trip removed: " + trip.destinations.from.name + " > " + trip.destinations.to.name)
                }
            }

            calculate_roadtrips()
            resolve()
        })
    })

}

function time() {
    var date = new Date()
    return `${date.getFullYear()}/${date.getMonth()+1}/${date.getDate()} ${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}`
}

function log(message) {
    message = "[" + time() + "] " + message
    console.log(message)
    logs += message + "\n"
    fs.writeFileSync("logs/" + LOG_NAME, logs)
}

function calculate_roadtrips() {
    var old_road_trips = JSON.parse(JSON.stringify(road_trips))
    road_trips = []
    var new_road_trips = []

    for (var original_trip of trips) {
        find_trip([], original_trip)
    }

    for (var road_trip of road_trips) {
        var data = old_road_trips.filter(obj => {
            return obj["signature"] != road_trip.signature
        })
        if (data.length == 0) {
            log("New road trip, with " + road_trip.trail.length + " stops.")
            new_road_trips.push(road_trip)
        }
    }

    if (new_road_trips.length > 0) {
        send_email(new_road_trips)
    }

    log(`Found ${road_trips.length} road trips${road_trips.length > 0 ? "!" : "."}`)
}

function find_trip(trail, new_trip) {

    trail.push(new_trip) // Push the new trip
    if (trail.length > 1 && trail[0].destinations.from.id == trail[trail.length - 1].destinations.to.id) {
        road_trips.push({
            trail,
            signature: md5(JSON.stringify(trail))
        })
    }

    for (var trip of trips) { // Loop through all trips
        // See if this trip could follow in a road trip?

        if (trip.destinations.from.id == trail[trail.length - 1].destinations.to.id) {
            for (var trail_trip of trail) {
                // Make sure the trip is not already in the trail.
                if (trail_trip.id == trip.id) return
            }
            find_trip(trail, trip) // Continue recursion
        }
    }
}

function update_station(station) {
    if (!stations[station.id]) {
        stations[station.id] = station

        rp(STATION_URL + station.id).then(html => {
            let dom = new JSDOM(html)
            stations[station.id].street = dom.window.document.getElementById("ctl00_ContentPlaceHolder1_street").textContent
            stations[station.id].city = dom.window.document.getElementById("ctl00_ContentPlaceHolder1_postaladdress").textContent
            stations[station.id].postalcode = dom.window.document.getElementById("ctl00_ContentPlaceHolder1_postalcode").textContent
            log("Added new station, " + station.name)
            save()
        })
    }
}

console.log(`
         OpenRoads V.1.0
  ~ Free road trips in Sweden ~

Set to refresh every ${config.minute_interval} minutes.`)

download_list()

async function send_email(new_road_trips) {
    if (!config.gmail.username) {
        log("WARN: Did not send email because it is not configured!")
        return
    }

    let transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        auth: {
            user: config.gmail.username,
            pass: config.gmail.password,
        },
    });

    var email = fs.readFileSync("email.html")

    email += `We found ${new_road_trips.length} new roadtrip(s)!</span>
    <div id="road-trips">`
    for (var road_trip of new_road_trips) {
        email += `<div class="road-trip">`
        for (var stop of road_trip.trail) {
            email += `
            <div class="destinations">${stop.destinations.from.name} → ${stop.destinations.to.name}</div>
            <div class="car">${stop.car}</div>`
        }
        email += "</div>"
    }

    email += "</div></body></html>"

    await transporter.sendMail({
        from: 'OpenRoads',
        to: config.clients.join(", "),
        subject: new_road_trips.length + " new road trip(s)!",
        text: "We found new road trips!",
        html: email
    });

    log("Sent email notice")
}


setInterval(() => {
    download_list()
}, config.minute_interval * 1000 * 60)