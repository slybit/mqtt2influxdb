'use strict'

const Influx = require('influx');
const mustache = require('mustache');
const Wax = require('@jvitela/mustache-wax');
const mqtt = require('mqtt');
const { createLogger, format, transports } = require('winston');
const config = require('./config.js').parse();

Wax(mustache);

mustache.Formatters = {
    "multiply": function (value, multiplier) {
        console.log('mul');
        console.log(value);
        return value * multiplier;
    },
    "add": function (value, a) {
        return value + a;
    },
};

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


const influx = new Influx.InfluxDB(config.influx);


const parseInstants = function (topic, message) {
    // ensure data is Object
    let data = {};
    data.M = processMessage(message);
    for (const r of config.instants) {
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
                writeToInfux(point, r.retentionPolicy);
            } else {
                if (!point.measurement)
                    logger.warn('Rewrite resulted in missing measurement. Nothing sent to influx DB.');
                if (Object.keys(point.fields).length == 0)
                    logger.warn('Rewrite resulted in empty fields array. Nothing sent to influx DB.');
            }

            // break the for loop if topic matched and config does not say "continue : true"
            if (!(r.continue === true)) break;
        }

    }

}


/*
This is how we keep track of stats

For each stat item in the config file, we keep track of measurementObjects.
A measurementObjects is indexed by the:
    - measurement
    - tags
We store it as `stat.measurements[measurement][tags] = measurementObj`.

A measurementObjects has the following attributes:
- An InfluxDB Point
- The value of each field defined in the config file
- The timestamp of the latest update
*/


const parseStats = function (topic, message) {
    // ensure data is Object
    let data = {};
    data.M = processMessage(message);
    for (const stat of config.stats) {
        let regex = RegExp(stat.regex);
        data.T = regex.exec(topic);
        if (data.T) {
            updateStatMeasurementObj(stat, data);
            // break the for loop if topic matched and config does not say "continue : true"
            if (!(stat.continue === true)) break;
        }
    }
}


const updateStatMeasurementObj = function (stat, data) {
    const timestamp = new Date();
    // render the measurement name
    const measurement = render(stat.measurement, data);
    // if this a new measurement, init the stat.measurements object with an empty Map
    if (!stat.measurements.has(measurement)) stat.measurements.set(measurement, new Map());
    const measurementObjects = stat.measurements.get(measurement);
    // now lookup the measurementObj that we need based on the tags
    // exit if no tags where defined in the config
    if (stat.tags === undefined) {
        logger.error("Missing tag list for stat with measurement {}", stat.measurement);
        return;
    }
    const tags = {};
    for (let tag in stat.tags) {
        tags[tag] = render(stat.tags[tag], data);
    }
    // lazy solution of using the tag object as a map index
    const tagsId = JSON.stringify(tags);
    // if no measurementObj exists for this set of tags, initialize it
    if (!measurementObjects.has(tagsId)) measurementObjects.set(tagsId, initMeasurementObj(timestamp, measurement, tags, stat.fields, data));
    // finally obtain the measurementObj so we can update it
    const measurementObj = measurementObjects.get(tagsId);

    const point = measurementObj.point;
    // update the field values
    for (let field of stat.fields) {
        let val = render(field.source, data);
        if (!isNaN(val)) val = Number(val);
        switch (field.op) {
            case 'max':
                point.fields[field.name] = Math.max(val, point.fields[field.name]);
                break;
            case 'min':
                point.fields[field.name] = Math.min(val, point.fields[field.name]);
                break;
            case 'add':
                point.fields[field.name] += val;
                break;
            case 'avg':
                let a = measurementObj.storage[field.name] * (timestamp - measurementObj.timestamp) / (stat.interval * 30000);
                point.fields[field.name] += a;
                measurementObj.storage[field.name] = val;
                break;
        }

    }
    measurementObj.timestamp = timestamp;
}


const initMeasurementObj = function (timestamp, measurement, tags, fields, data) {
    const measurementObj = {};
    measurementObj.timestamp = timestamp;
    // create static parts of the influxdb point
    const point = {};
    point.measurement = measurement;
    point.tags = tags;
    measurementObj.point = point;
    measurementObj.storage = {};
    point.fields = {};
    for (let field of fields) {
        let val = render(field.source, data);
        if (!isNaN(val)) val = Number(val);
        // init the actual field values
        switch (field.op) {
            case 'max':
                point.fields[field.name] = val;
                break;
            case 'min':
                point.fields[field.name] = val;
                break;
            case 'add':
                point.fields[field.name] = 0;
                break;
            case 'avg':
                measurementObj.storage[field.name] = val;
                point.fields[field.name] = 0.0;
                break;
        }
    }
    return measurementObj;
}


// finalizes the averages and end of a cycle, just before sending them to influx
const finalizeAverages = function (measurementObj, stat) {
    const timestamp = new Date();
    const point = measurementObj.point;
    for (let field of stat.fields) {
        switch (field.op) {
            case 'avg':
                let a = measurementObj.storage[field.name] * (timestamp - measurementObj.timestamp) / (stat.interval * 30000);
                point.fields[field.name] += a;
                break;
        }
    }
    measurementObj.timestamp = timestamp;
}

// resets the averages and end of a cycle, just after sending them to influx
const resetAverages = function (measurementObj, stat) {
    const point = measurementObj.point;
    for (let field of stat.fields) {
        switch (field.op) {
            case 'avg':
                point.fields[field.name] = 0.0;
                break;
        }
    }
}







const render = function (template, data) {
    if (typeof (template) === 'string') {
        return mustache.render(template, data);
    } else {
        return template;
    }
}

// evaluates the mqtt message
// expects message to be a string
let processMessage = function (message) {
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




const setMqttHandlers = function (mqttClient) {
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
            if (config.instants !== undefined && Array.isArray(config.instants))
                parseInstants(topic, message);
            if (config.stats !== undefined && Array.isArray(config.stats))
                parseStats(topic, message);
        } else {
            logger.silly("MQTT ignored initial retained  %s : %s", topic, message)
        }
    });
}

const writeToInfux = function (point, retentionPolicy = 'autogen') {
    
    logger.verbose('Publishing %s, fields: %s, tags: %s, timestamp: %s', point.measurement, JSON.stringify(point.fields), JSON.stringify(point.tags), point.timestamp);
    logger.verbose('Retention policy: %s', retentionPolicy);
    influx.writePoints([
        point
    ],{
        retentionPolicy: retentionPolicy,
    }).catch(err => {
        logger.warn(`Error saving data to InfluxDB! ${err.stack}`)
    }
    )
}


const createRetentionPolicies = () => {
    influx.showRetentionPolicies().then(policies => {
        for (let p of policies) {
            for (let rp of config.influx.retentionPolicies) {
                if (p.name === rp.name) rp.exists = true;
            }
        }
        for (let rp of config.influx.retentionPolicies) {
            if (!rp.exists) {
                influx.createRetentionPolicy(rp.name, {
                    duration: rp.duration,
                    replication: rp.replication ? rp.replication : 1
                })
            }
        }
    });
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
        createRetentionPolicies();
    })
    .catch(err => {
        logger.error('Error connecting to the Influx database!');
        logger.error(err);
        clearInterval(repeater);
    }
    )







/* Repeating loop for the stats */



const checkRepeaterItem = function (stat) {

    stat.count = stat.count + 1;
    if (stat.count == stat.interval) {
        stat.count = 0;

        stat.measurements.forEach(function (measurementItem, measurementName) {
            measurementItem.forEach(function (measurementObj, tagsId) {
                if (measurementObj === undefined) return;
                finalizeAverages(measurementObj, stat);
                const point = measurementObj.point;
                if (point === undefined) return;
                if (point.measurement && Object.keys(point.fields).length > 0) {
                    writeToInfux(point, stat.retentionPolicy);
                    logger.debug("Stats send to influxdb: " + JSON.stringify(point.fields));
                } else {
                    if (!point.measurement)
                        logger.warn('Stats resulted in missing measurement. Nothing sent to influx DB.');
                    if (Object.keys(point.fields).length == 0)
                        logger.warn('Stats resulted in empty fields array. Nothing sent to influx DB.');
                }
                resetAverages(measurementObj, stat);
            })
        })

    }

}

// start up the repeater
const repeater = setInterval(function () {
    // go over all map items
    for (const stat of config.stats) {
        checkRepeaterItem(stat);
    }
}, 30 * 1000);

