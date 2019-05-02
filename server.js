'use strict'

//load environment variables from the .env file
require('dotenv').config();

// application Dependencies
const express = require('express');
const app = express();
const cors = require('cors');
const superagent = require('superagent');
const pg = require('pg');

// Application Setup
const PORT = process.env.PORT;
app.use(cors());

app.get('/testing', (request, response) => {
  console.log('found the testing route');
  response.send('<h1> HEY WORLD </h1>');
});

const client = new pg.Client(process.env.DATABASE_URL);
client.connect();
client.on('error',error => console.log(error));

//API Routes
// app.get('/location', searchToLatLong)
app.get('/location', searchToLatLong)
app.get('/weather', searchForWeatherAndTime)
app.get('/events', searchForEvents)

app.listen(PORT, () => console.log(`Listen on Port NEW ${PORT}.`)); 

// ERROR HANDLER
function handleError(err, res) {
  console.error(err);
  if (res) res.status(500).send('Sorry, something went wrong');
}

//Helper Functions
//Dealing With Geo Data

function searchToLatLong(request, response) {
  let query = request.query.data;

  // Define the search query
  let sql = `SELECT * FROM locations WHERE search_query=$1;`;
  let values = [query];


  // Make the query of the Database
  client.query(sql, values)
    .then(result => {
      // Did the DB return any info?
      if (result.rowCount > 0) {
        console.log(result.rows[0]);
        response.send(result.rows[0]);
      } else {
        // otherwise go get the data from the API
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${request.query.data}&key=${process.env.GEOCODE_API_KEY}`;

        superagent.get(url)
          .then(result => {
            if (!result.body.results.length) { throw 'NO DATA'; }
            else {
              let location = new Location(query, result.body.results[0]);

              let newSQL = `INSERT INTO locations (search_query, formatted_address, latitude, longitude) VALUES ($1, $2, $3, $4) RETURNING ID;`;
              let newValues = Object.values(location);

              client.query(newSQL, newValues)
                .then(data => {
                  // attach the returning id to the location object
                  location.id = data.rows[0].id;
                  console.log(location);
                  response.send(location);
                });
            }
          })
          .catch(error => {handleError(error, response)
            throw 'error!';
          });
      }
    });
}


function Location(query, location) {
  this.search_query = query;
  this.formatted_query = location.formatted_address;
  this.latitude = location.geometry.location.lat;
  this.longitude = location.geometry.location.lng;
}

//Dealing With Weather
function searchForWeatherAndTime(request, response) {
  let query = request.query.data.id;
  let sql = `SELECT * FROM weathers WHERE location_id=$1;`;
  let values= [query];

  client.query(sql, values)
    .then(result =>{
      if (result.rowCount > 0){
        console.log('weather from sql');
        response.send(result.rows);
      } else {
        let url = `https://api.darksky.net/forecast/${process.env.WEATHER_API_KEY}/${request.query.data.latitude},${request.query.data.longitude}`;
        superagent.get(url)
          .then(weatherResults => {
            console.log('weather from api');
            if (!weatherResults.body.daily.data.length) {throw 'no data!';}
            else {
              const weatherSummaries = weatherResults.body.daily.data.map(day=>{
                let daySummary = new Weather(day);
                daySummary.id = query;
                let newSql = `INSERT INTO weathers (time, forecast, location_id) VALUES ($1, $2, $3);`;
                let newValues = Object.values(daySummary);
                client.query(newSql, newValues);
                return daySummary;
              });
              response.send(weatherSummaries);
            }
          })
      }
    })
    .catch(error => handleError(error, response));
}

function Weather(data) {
  this.time = new Date(data.time * 1000).toString().slice(0, 15);
  this.forecast = data.summary;
}

function searchForEvents(request, response) {
  let query = request.query.data.id;
  let sql = `SELECT * FROM events WHERE event_id = $1;`;
  let eventValues = [query];
  client.query(sql, eventValues)
    .then(results => {
      if (results.rowCount > 0) {
        response.send(results.rows);
      }
      else {
        let url = `https://www.eventbriteapi.com/v3/events/search/?location.latitude=${request.query.data.latitude}&location.longitude=${request.query.data.longitude}&token=${process.env.EVENTBRITE_API_KEY}`;
        superagent.get(url)
          .then(eventResults => {
            if (!eventResults.body.events.length){throw 'error no data!';}
            else {
              let eventsSummaries = eventResults.body.events.map(event => {
                let eventSummary = new Event(event);
                eventSummary.id = query;
                let newSql = `INSERT INTO events(url, name, events_date, summary, event_id) VALUES ($1, $2, $3, $4, $5);`;
                let newValues = Object.values(eventSummary);
                client.query(newSql, newValues);
                return eventSummary;
              });
              response.send(eventsSummaries);
            }
          });
      }
    })
    .catch(err =>handleError(err, response))
}

function Event(data){
  this.url = data.url;
  this.name = data.name.text;
  this.events_date = data.start.local;
  this.summary = data.summary;
}
