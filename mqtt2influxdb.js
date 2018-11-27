'use strict'

const Influx = require('influx');
const mustache = require('mustache');
const config = require('./config.js').parse();

let parse = function(topic, message, c) {
    // ensure data is Object
    let data = {};
    try {
        data.M = JSON.parse(message);
    } catch (err) {
        data.M = { 'value' : message};
    }
    console.log(data);
    console.log(c);
    let regex = RegExp(c.regex);
    data.T = regex.exec(topic);
    console.log(data);
    console.log(mustache.render(c.measurement, data));



}

parse('knx/status/a/b/c', JSON.stringify({'dst' : '0/0/108', 'value' : 10}), config.topics["knx/status/+/+/+"]);

//const influx = new Influx.InfluxDB(config.influx);

/**
 * Now, we'll make sure the database exists and boot the app.
 */
/*
influx.getDatabaseNames()
  .then(names => {
    if (!names.includes('mqtt2influx')) {
      return influx.createDatabase('mqtt2influx');
    }
  })
  .then(() => {
      console.log('Influx DB ready to use.');
  })
  .catch(err => {
    console.error('Error creating Influx database!');
  })

influx.writePoints([
    {
      measurement: 'response_times',
      tags: { host: 'test' },
      fields: { value: 10 }
    }
    ]).catch(err => {
    console.error(`Error saving data to InfluxDB! ${err.stack}`)
})
*/