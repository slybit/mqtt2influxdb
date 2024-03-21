const yaml = require('js-yaml');
const fs = require('fs');

exports.parse = function () {
    const file = process.env.CONFIG || './config/config.yaml';
    let config = {};
    // read the original config in 'config'
    if (fs.existsSync(file)) {
        try {
            config = yaml.load(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            console.log(e);
            process.exit();
        }
    } else {
        console.log("Config file not found at " + file);
        process.exit();
    }

    return config;
}


