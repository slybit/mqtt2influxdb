'use strict'

const Influx = require('influx');
const mustache = require('mustache');
const mqtt = require('mqtt');
const { createLogger, format, transports } = require('winston');
const config = require('./config.js').parse();

let justStarted = true;

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

// maps topic -> {influxDB point, factor, counter}
const repeaters = new Map();

const influx = new Influx.InfluxDB(config.influx);

const parse = function(topic, message) {
    // ensure data is Object
    let data = {};
    data.M = processMessage(message);
    for (const r of config.rewrites) {
        let regex = RegExp(r.regex);
        data.T = regex.exec(topic);
        let point = {};
        if (data.T) {
            point.measurement = render(r.measurement, data);
            if (r.timestamp) {
                let ts = Number(render(r.timestamp, data));
                if (!isNaN(ts)) point.timestamp = new Date(ts);
            }
            point.tags = {};
            for (var tag in r.tags) {
                point.tags[tag] = render(r.tags[tag], data);
            }
            point.fields = {};
            for (var field in r.fields) {
                point.fields[field] = render(r.fields[field], data);
                if (!isNaN(point.fields[field])) point.fields[field] = Number(point.fields[field]);
            }

            if (point.measurement && Object.keys(point.fields).length > 0) {
                writeToInfux(point);
            } else {
                if (!point.measurement)
                    logger.warn('Rewrite resulted in missing measurement. Nothing sent to influx DB.');
                if (Object.keys(point.fields).length == 0)
                    logger.warn('Rewrite resulted in empty fields array. Nothing sent to influx DB.');
            }

            // setup a repeater if necessary
            if (r.factor) {
                logger.silly('Setting repeater for %s', topic);
                // remove timestamp from point as it will be incorrect for future insertions
                delete point.timestamp;
                repeaters.set(topic, {'point' : point, 'factor' : r.factor, 'count' : 0});
            }

            // break the for loop if topic matched and config does not say "continue : true"
            if (!(r.continue === true)) break;
        }

    }

}


const render = function(template, data) {
    if (typeof(template) === 'string') {
        return mustache.render(template, data);
    } else {
        return template;
    }
}

// evaluates the mqtt message
// expects message to be a string
let processMessage = function(message) {
    let data = {};
    if (message === 'true') {
        data = 1;
    } else if (message === 'false') {
        data = 0;
    } else if (isNaN(message)) {
        try {
            data = JSON.parse(message);
        } catch (err) {
            data = message; // will be a string
        }
    } else {
        data = Number(message);
    }
    return data;
}




const setMqttHandlers = function(mqttClient) {
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

    mqttClient.on('message', function (topic, message, packet) {
        // ignore the initial retained messages
        if (!packet.retain) justStarted = false;
        if (!justStarted || config.retained) {
            // message is a buffer
            logger.silly("MQTT received %s : %s", topic, message)
            message = message.toString();
            parse(topic, message);
        } else {
            logger.silly("MQTT ignored initial retained  %s : %s", topic, message)
        }
    });
}

const writeToInfux = function(point) {
    logger.verbose('Publishing %s, fields: %s, tags: %s, timestamp: %s', point.measurement, JSON.stringify(point.fields), JSON.stringify(point.tags), point.timestamp);
    influx.writePoints([
            point
        ]).catch(err => {
            logger.warn(`Error saving data to InfluxDB! ${err.stack}`)
        }
    )
}





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
        logger.info('Influx DB ready to use. Connecting to MQTT.');
        let mqttClient = mqtt.connect(config.mqtt.url, config.mqtt.options);
        setMqttHandlers(mqttClient);
    })
    .catch(err => {
        logger.error('Error connecting to the Influx database!');
        logger.error(err);
        clearInterval(repeater);
    }
)

const checkRepeaterItem = function(value, key, map) {
    value.count = value.count + 1;
    if (value.count == value.factor) {
        value.count = 0;
        writeToInfux(value.point);
        logger.info("repeated: " + JSON.stringify(value));
    }
}

// start up the repeater
const repeater = setInterval(function() {
    // go over all map items
    repeaters.forEach(checkRepeaterItem);
}, 30 * 1000);

