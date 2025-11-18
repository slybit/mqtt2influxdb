'use strict'

const Influx = require('influx');
const mustache = require('mustache');
const Wax = require('@jvitela/mustache-wax');
const mqtt = require('mqtt');
const { logger } = require('./standardlogger.js');
const config = require('./config.js').parse();

// verify and amand the config object
if (config.stats) {
    // create a measurements map and initial count in each stats element
    for (let stat of config.stats) {
        stat.measurements = new Map();   // maps measurement -> list of {influxDB point, timestamp}
        stat.count = 0;                  // used to keep track of when to push data to influxdb based on the interval
    }
}


Wax(mustache);

mustache.Formatters = {
    "multiply": function (value, multiplier) {
        return value * multiplier;
    },
    "add": function (value, a) {
        return value + a;
    },
};

let justStarted = true;

// InfluxDB connection state tracking
let influxConnected = false;
let reconnectTimeout = null;

// bucket of points that we need to write to influxdb
// this will be indexed
// - per database
// - per retentionPeriod
const bucket = {};


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
            } else {
                point.timestamp = new Date();
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
                pushToBucket(point, r.database, r.retentionPolicy);
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
            logger.verbose('subscribed to', {'topic': topic});
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
            logger.silly("MQTT received", {'topic': topic, 'message': message})
            message = message.toString();
            if (config.instants !== undefined && Array.isArray(config.instants))
                parseInstants(topic, message);
            if (config.stats !== undefined && Array.isArray(config.stats))
                parseStats(topic, message);
        } else {
            logger.silly("MQTT ignored initial retained", {'topic': topic, 'message': message})
        }
    });
}

const pushToBucket = function (point, database = undefined, retentionPolicy = 'autogen') {

    const db = database ? database : config.influx.database;
    logger.debug('Add to bucket', {'database': db, 'measurement': point.measurement, 'fields': point.fields, 'tags': point.tags, 'timestamp': point.timestamp, 'retention': retentionPolicy});

    if (!bucket.hasOwnProperty(db)) bucket[db] = {};
    if (!bucket[db].hasOwnProperty(retentionPolicy)) bucket[db][retentionPolicy] = [];
    
    bucket[db][retentionPolicy].push(point);
}




const attemptInfluxReconnect = async () => {
    if (reconnectTimeout) return; // prevent multiple simultaneous reconnection attempts
    
    logger.info('Attempting to reconnect to InfluxDB...');
    
    try {
        let names = await influx.getDatabaseNames();
        await createDatabases(names);
        influxConnected = true;
        logger.info('Successfully reconnected to InfluxDB');
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }
    } catch (err) {
        influxConnected = false;
        logger.warn('Failed to reconnect to InfluxDB, will retry in 1 minute');
        reconnectTimeout = setTimeout(async () => {
            reconnectTimeout = null;
            await attemptInfluxReconnect();
        }, 60 * 1000);
    }
};

const createDatabases = async (names) => {
    // name contains the already existing databases
    for (let dbItem of config.databases) {
        if (!names.includes(dbItem.name)) {
            await influx.createDatabase(dbItem.name);            
            logger.info(`Create influx database ${dbItem.name}`);
        }
        await createRetentionPolicies(dbItem);
    }
    

}


const createRetentionPolicies = async (dbItem) => {
    let policies = await influx.showRetentionPolicies(dbItem.name);        
    for (let p of policies) {
        for (let rp of dbItem.retentionPolicies) {
            if (p.name === rp.name) rp.exists = true;
        }
    }
    for (let rp of dbItem.retentionPolicies) {
        if (!rp.exists) {
            await influx.createRetentionPolicy(rp.name, {
                database: dbItem.name,
                duration: rp.duration,
                replication: rp.replication ? rp.replication : 1
            });
            logger.info(`Create influx retention policy ${rp.name} for database ${dbItem.name}`);
        }
    }
}









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
                    logger.debug("Stats sent to influxdb", {'fields': point.fields});
                    point.timestamp = new Date(); // set current time as timestamp for this point
                    pushToBucket(point, stat.database, stat.retentionPolicy);
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




/**
 * Actually run something is below this line.
 */ 

// setup the the repeater for the stats
const repeater = setInterval(function () {
    // go over all map items
    for (const stat of config.stats) {
        checkRepeaterItem(stat);
    }
}, 30 * 1000);

// setup the repeater to write the bucket to influxdb
const writeRepeater = setInterval(async function () {
    
    // skip writing if not connected
    if (!influxConnected) {
        logger.debug('Skipping write to InfluxDB - not connected');
        return;
    }
    
    // go over the entries in the bucket
    let i = 0;
    for (const db in bucket) {
        for (const retentionPolicy in bucket[db]) {
            const points = bucket[db][retentionPolicy];
            if (points.length > 0) {
                setTimeout(async () => {
                    try {
                        await influx.writePoints(points, {
                            database: db,
                            retentionPolicy: retentionPolicy
                        });
                        logger.debug(`Wrote ${points.length} points to database ${db} with retention policy ${retentionPolicy}`);
                        // clear the bucket for this retention policy only on success
                        bucket[db][retentionPolicy] = [];
                    } catch (err) {
                        logger.warn(`Error saving data to database ${db} with retention policy ${retentionPolicy}! ${err.stack}`);
                        // mark as disconnected and trigger reconnection
                        if (influxConnected) {
                            influxConnected = false;
                            logger.error('InfluxDB connection lost, initiating reconnection attempts');
                            await attemptInfluxReconnect();
                        }
                        // keep points in bucket for retry when connection is restored
                    }
                }, i++ * 200);
            }
        }
    }
}, 60*1000);


// Create our influx instance
const influx = new Influx.InfluxDB(config.influx);

const go = async () => {
    try {
        // Now, we'll make sure the databases exist
        let names = await influx.getDatabaseNames();
        await createDatabases(names);
        influxConnected = true;
        logger.info('Influx DB ready to use. Connecting to MQTT.');
        let mqttClient = mqtt.connect(config.mqtt.url, config.mqtt.options);
        setMqttHandlers(mqttClient);        
    } catch (err) {
            logger.error('Error connecting to the Influx database!');
            logger.error(err);
            influxConnected = false;
            logger.info('Will attempt to reconnect to InfluxDB in 1 minute');
            // Start MQTT connection anyway to collect data
            let mqttClient = mqtt.connect(config.mqtt.url, config.mqtt.options);
            setMqttHandlers(mqttClient);
            // Schedule reconnection attempts
            reconnectTimeout = setTimeout(async () => {
                reconnectTimeout = null;
                await attemptInfluxReconnect();
            }, 60 * 1000);
    }
}


go();




