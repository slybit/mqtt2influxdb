'use strict'

const Influx = require('influx');
const mustache = require('mustache');
const mqtt = require('mqtt');
const { createLogger, format, transports } = require('winston');
const config = require('./config.js').parse();

// Initate the logger
const logger = createLogger({
    level: config.loglevel,
    format: format.combine(
      format.colorize(),
      format.splat(),
      format.simple(),
    ),
    transports: [new transports.Console()]
});

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
            logger.verbose('Published %s, fields: %s, tags: %s', measurement, JSON.stringify(fields), JSON.stringify(tags));
        }
    }

}

let start = (new Date).getTime();
parse('knx/status/a/b/c', JSON.stringify({'dst' : '0/0/108', 'value' : '10', 'label' : 'shit'}), config.topics["knx/status/+/+/+"]);
console.log("time needed: " + ((new Date).getTime() - start));

const influx = new Influx.InfluxDB(config.influx);

/**
 * Now, we'll make sure the database exists and boot the app.
 */

influx.getDatabaseNames()
    .then(names => {
      if (!names.includes('mqtt2influx')) {
        return influx.createDatabase('mqtt2influx');
      }
    })
    .then(() => {
        console.log('Influx DB ready to use. Connecting to MQTT.');
        let mqttClient = mqtt.connect(config.mqtt.url, config.mqtt.options);
        setMqttHandlers(mqttClient);
    })
    .catch(err => {
        console.error('Error creating Influx database!');
    }
)

let setMqttHandlers = function(mqttClient) {
    mqttClient.on('connect', function () {
        logger.info('MQTT connected');
        for (const topic of config.topics) {
            mqttClient.subscribe(topic);
            logger.verbose('subscribed to %s', topic);
        }
    });

    mqttClient.on('close', function () {
        logger.info('MQTT disconnected');
    });

    mqttClient.on('reconnect', function () {
        logger.info('MQTT trying to reconnect');
    });

    mqttClient.on('message', function (topic, message) {
        // message is a buffer
        message = message.toString();
        console.log(topic + "  " + message);
        parse(topic, message);
    });

}

/*
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
