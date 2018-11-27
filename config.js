const yaml = require('js-yaml');
const fs   = require('fs');

exports.parse = function () {
    const file = process.env.MQTT_CONFIG || 'config.yaml';
    if (fs.existsSync(file)) {
        try {
          return yaml.safeLoad(fs.readFileSync(file, 'utf8'));
        } catch (e) {
          console.log(e);
          process.exit();
        }
    } else {
        return {
            loglevel: 'silly',
            influx: {
                database: 'mqtt2influx',
                host: '192.168.1.150',
                port: 8086
            },
            mqtt: {
                url: 'mqtt://localhost'
            }
        }
    }
}