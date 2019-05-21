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
client.on('error', error => console.log(error));

//API Routes
app.get('/location', searchToLatLong)
app.get('/yelp', searchForYelp)
app.get('/weather', searchForWeatherAndTime)
app.get('/events', searchForEvents)
app.get('/movies', searchForMovies)

app.listen(PORT, () => console.log(`Listen on Port NEW ${PORT}.`));

// ERROR HANDLER
function handleError(err, res) {
  console.error(err);
  if (res) res.status(500).send('Sorry, something went wrong');
}



function getDataFromDB(sqlInfo) {
  let condition = '';
  let values = [];
  if (sqlInfo.searchQuery) {
    condition = 'search_query';
    values = [sqlInfo.searchQuery];
  } else {
    condition = 'location_id';
    values = [sqlInfo.id];
  }
  let sql = `SELECT * FROM ${sqlInfo.endpoint}s WHERE ${condition} = $1;`;
  try {
    return client.query(sql, values)
  }
  catch
  (err) { handleError(err); }

}

function saveToDB(sqlInfo) {
  //create placeholders
  let params = [];
  for (let i = 1; i <= sqlInfo.values.length; i++) {
    params.push(`$${i}`);
  }
  let sqlParams = params.join();
  let sql = '';
  if (sqlInfo.searchQuery) {
    //location
    sql = `INSERT INTO ${sqlInfo.endpoint}s (${sqlInfo.columns}) VALUES (${sqlParams}) RETURNING ID;`;
  }
  else {
    // all other endspoints
    sql = `INSERT INTO ${sqlInfo.endpoint}s (${sqlInfo.columns}) VALUES (${sqlParams});`;
  }
  //save the data
  try {
    return client.query(sql, sqlInfo.values);
  }
  catch
  (err) { handleError(err) }
}

function checkTimeOuts(sqlInfo, sqlData) {//Follow the trail, where does sqlData come from?
  const timeouts = {
    weather: 15 * 1000, //15 seconds
    yelp: 24 * 1000 * 60 * 60, //24 hours
    movie: 30 * 1000 * 60 * 60 * 24, //30 days
    event: 6 * 1000 * 60 * 60, //6 hours
    trail: 7 * 1000 * 60 * 60 * 24 //7 days
  };

  if (sqlData.rowCount > 0) {
    let ageOfResults = (Date.now() - sqlData.rows[0].created_at);

    //for debugging only
    // console.log(sqlInfo.endpoint, ' AGE:', ageOfResults);
    // console.log(sqlInfo.endpoint, ' Timeout:', timeouts[sqlInfo.endpoint]);

    if (ageOfResults > timeouts[sqlInfo.endpoint]) {
      let sql = ` DELETE FROM ${sqlInfo.endpoint}s WHERE location_id=$1;`;
      let values = [sqlInfo.id];
      client.query(sql, values)
        .then(() => { return null; })
        .catch(err => handleError(err));
    }
    else { return sqlData; }
  }
}

//Helper Functions
//Dealing With Geo Data

function searchToLatLong(request, response) {
  let sqlInfo = {
    searchQuery: request.query.data,
    endpoint: 'location'
  }
  getDataFromDB(sqlInfo)
    .then(result => {
      // Did the DB return any info?
      if (result.rowCount > 0) {
        response.send(result.rows[0]);
      } else {
        // otherwise go get the data from the API
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${request.query.data}&key=${process.env.GEOCODE_API_KEY}`;

        superagent.get(url)
          .then(result => {
            if (!result.body.results.length) { throw 'NO DATA'; }
            else {
              let location = new Location(sqlInfo.searchQuery, result.body.results[0]);
              sqlInfo.columns = Object.keys(location).join();
              sqlInfo.values = Object.values(location);
              saveToDB(sqlInfo)
                .then(data => {
                  // attach the returning id to the location object
                  location.id = data.rows[0].id;
                  response.send(location);
                });
            }
          })
          .catch(error => {
            handleError(error, response)
          });
      }
    });
}

//Dealing With Weather
function searchForWeatherAndTime(request, response) {
  let sqlInfo = {
    id: request.query.data.id,
    endpoint: 'weather'
  }
  getDataFromDB(sqlInfo)
    .then(data => checkTimeOuts(sqlInfo, data))
    .then(result => {
      if (result) {
        response.send(result.rows);
      } else {
        let url = `https://api.darksky.net/forecast/${process.env.WEATHER_API_KEY}/${request.query.data.latitude},${request.query.data.longitude}`;
        superagent.get(url)
          .then(weatherResults => {
            if (!weatherResults.body.daily.data.length) { throw 'no data!'; }
            else {
              const weatherSummaries = weatherResults.body.daily.data.map(day => {
                let summary = new Weather(day);
                summary.location_id = sqlInfo.id;
                sqlInfo.columns = Object.keys(summary).join();
                sqlInfo.values = Object.values(summary);
                saveToDB(sqlInfo);
                return summary;
              });
              response.send(weatherSummaries);
            }
          })
          .catch(error => handleError(error, response));
      }
    })
}

function searchForEvents(request, response) {
  let sqlInfo = {
    id: request.query.data.id,
    endpoint: 'event'
  }
  getDataFromDB(sqlInfo)
    .then(data => checkTimeOuts(sqlInfo, data))
    .then(result => {
      if (result) {
        response.send(result.rows);
      }
      else {
        const url = `https://www.eventbriteapi.com/v3/events/search/?location.latitude=${request.query.data.latitude}&location.longitude=${request.query.data.longitude}&token=${process.env.EVENTBRITE_API_KEY}`;
        superagent.get(url)
          .then(eventResults => {
            if (!eventResults.body.events.length) { throw 'error no data!'; }
            else {
              let eventsSummaries = eventResults.body.events.map(event => {
                let eventSummary = new Event(event);
                eventSummary.location_id = sqlInfo.id;
                sqlInfo.columns = Object.keys(eventSummary).join();
                sqlInfo.values = Object.values(eventSummary);
                saveToDB(sqlInfo);
                return eventSummary;
              });
              response.send(eventsSummaries);
            }
          })
          .catch(err => handleError(err, response))
      }
    })
}

function searchForYelp(request, response) {
  let sqlInfo = {
    id: request.query.data.id,
    endpoint: 'yelp'
  }
  getDataFromDB(sqlInfo)
    .then(data => checkTimeOuts(sqlInfo, data))

    .then(result => {
      if (result) {
        response.send(result.rows);
      }
      else {
        const url = `https://api.yelp.com/v3/businesses/search?latitude=${request.query.data.latitude}&longitude=${request.query.data.longitude}`;
        superagent(url)
          .set('Authorization', `Bearer ${process.env.YELP_API_KEY}`)
          .then(yelpResults => {
            if (!yelpResults.body.businesses.length) { throw 'error no data'; }
            else {
              let yelpReviews = yelpResults.body.businesses.map(element => {
                let review = new Yelp(element);
                review.location_id = sqlInfo.id;
                sqlInfo.columns = Object.keys(review).join();
                sqlInfo.values = Object.values(review);
                saveToDB(sqlInfo);
                return review;
              });
              response.send(yelpReviews);
            }
          })
          .catch(err => handleError(err, response))
      }
    })
}

function searchForMovies(request, response) {
  let sqlInfo = {
    id: request.query.data.id,
    endpoint: 'movie'
  };
  getDataFromDB(sqlInfo)
    .then(data => checkTimeOuts(sqlInfo, data))
    .then(results => {
      if (results) {
        response.send(results.rows)
      }
      else {
        const url = `https://api.themoviedb.org/3/search/movie?api_key=${process.env.MOVIE_API_KEY}&query=${request.query.data.search_query}`
        superagent(url)
          .then(movieData => {
            if (!movieData.body.results.length) { throw 'error no data'; }
            else {
              let movieMap = movieData.body.results.map(rawMovieData => {
                let aMovie = new Movie(rawMovieData);
                aMovie.location_id = sqlInfo.id;
                sqlInfo.columns = Object.keys(aMovie).join();
                sqlInfo.values = Object.values(aMovie);
                saveToDB(sqlInfo);
                console.log('MOVIE INFOOOOO', aMovie);
                return aMovie;
              });
              response.send(movieMap);
            }
          })
          .catch(err => handleError(err,response));
      }
    })

}



//CONSTRUCTORS

function Location(query, location) {
  this.search_query = query;
  this.formatted_query = location.formatted_address;
  this.latitude = location.geometry.location.lat;
  this.longitude = location.geometry.location.lng;
}

function Weather(data) {
  this.time = new Date(data.time * 1000).toString().slice(0, 15);
  this.forecast = data.summary;
  this.created_at = Date.now();
}

function Event(data) {
  this.url = data.url;
  this.name = data.name.text;
  this.events_date = data.start.local;
  this.summary = data.summary;
  this.created_at = Date.now();
}
function Yelp(data) {
  this.name = data.name;
  this.image_url = data.image_url;
  this.price = data.price;
  this.rating = data.rating;
  this.url = data.url;
  this.created_at = Date.now();
}

function Movie(data) {
  this.title = data.original_title;
  this.released_on = data.release_date;
  this.total_votes = data.vote_count;
  this.average_votes = data.vote_average;
  this.popularity = data.popularity;
  this.image_url = `http://image.tmdb.org/t/p/w185/${data.poster_path}`;
  this.overview = data.overview;
  this.created_at = Date.now();
}
