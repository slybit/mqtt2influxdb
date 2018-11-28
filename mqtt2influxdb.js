'use strict'

const Influx = require('influx');
const mustache = require('mustache');
const config = require('./config.js').parse();

let parse = function(topic, message) {
    // ensure data is Object
    let data = {};
    try {
        data.M = JSON.parse(message);
    } catch (err) {
        data.M = { 'value' : message};
    }

    for (const r of config.rewrites) {
        let regex = RegExp(r.regex);
        data.T = regex.exec(topic);
        if (data.T) {
            let measurement = mustache.render(r.measurement, data);
            let tags = {};
            for (var tag in r.tags)
                tags[tag] = mustache.render(r.tags[tag], data);
            let fields = {};
            for (var field in r.fields) {
            fields[field] = mustache.render(r.fields[field], data);
            if (field === 'value')
                fields[field] = Number(fields[field]);
            }
            console.log(fields);      
        }
    }

}

let start = (new Date).getTime();
parse('knx/status/a/b/c', JSON.stringify({'dst' : '0/0/108', 'value' : '10', 'label' : 'shit'}), config.topics["knx/status/+/+/+"]);
console.log("time needed: " + ((new Date).getTime() - start));

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
    }
)

influx.writePoints([
    {
        measurement: 'response_times',
        tags: { host: 'test' },
        fields: { value: 10 }
    }
    ]).catch(err => {
      console.error(`Error saving data to InfluxDB! ${err.stack}`)
    }
)
*/