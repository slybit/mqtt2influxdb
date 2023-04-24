const yaml = require('js-yaml');
const fs   = require('fs');

exports.parse = function () {
    const file = process.env.MQTT_CONFIG || 'config.yaml';
    if (fs.existsSync(file)) {
        try {
            let c = yaml.load(fs.readFileSync(file, 'utf8'));
            if (c.stats) {
                // create a measurements map and initial count in each stats element
                for (let stat of c.stats) {
                    stat.measurements = new Map();   // maps measurement -> list of {influxDB point, timestamp}
                    stat.count = 0;                  // used to keep track of when to push data to influxdb based on the interval
                }
            }
            return c;
        } catch (e) {
            console.log(e);
            process.exit();
        }
    } else {
        return {
            loglevel: 'silly',
            influx: {
                database: 'mqtt2influx',
                host: 'localhost',
                port: 8086
            },
            mqtt: {
                url: 'mqtt://localhost'
            }
        }
    }
}




