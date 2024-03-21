const { ElasticsearchTransport } = require('winston-elasticsearch');
const winston = require('winston');
const { combine, timestamp, printf, colorize, align, splat } = winston.format;

// default logging config
const DEFAULT_CONFIG = {
    loglevel: 'info',
    ESlogging: {
        'enabled': false,
        'label': 'DEFAULT',
        'loglevel:': 'info',
        'options' : {
            'indexPrefix': 'logs',
            'clientOpts': {
                'node': 'http://localhost:9200'
            }
        }
    }
}
// merge default with the one from the config file
const config = Object.assign({}, DEFAULT_CONFIG, require('./config.js').parse());


const addLabel = winston.format((info) => {
    return {"label": config.ESlogging.label, ...info};
})();


const consoleFormat = combine(
    timestamp({
        format: 'YYYY-MM-DD HH:mm:ss',
    }),
    printf((info) => {
        let { timestamp, level, message, ...leftovers } = info;
        return `[${info.timestamp}] ${info.level.padEnd(7).toUpperCase()} | ${message} | ${JSON.stringify(leftovers)}`;
    })
);



const esTransportOpts = {
    format: combine(addLabel),
    level: config.ESlogging.loglevel,
    ...config.ESlogging.options
};
const esTransport = new winston.transports.Elasticsearch(esTransportOpts);


const logger = winston.createLogger({
    transports: [
        new winston.transports.Console({
            level: config.loglevel,
            format: consoleFormat
        }),
        esTransport
    ],
});

module.exports = { logger };
