const yaml = require('js-yaml');
const fs   = require('fs');

exports.parse = function () {
    const file = process.env.MQTT_CONFIG || 'config.yaml';
    if (fs.existsSync(file)) {
        try {
          return validate(yaml.safeLoad(fs.readFileSync(file, 'utf8')));
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

validate = function(c) {
    for (const r of c.rewrites) {
        // check that repeat parameter is a valid number
        // calculate the repeat factor
        if (r.repeat)
            if (!isNaN(r.repeat)) {
                r.factor = Math.ceil(r.repeat / 30);
            } else {
                console.log('not a number');
                throw new Error('Repeat parameter must be a number!')
            }
    }
    return c;
}