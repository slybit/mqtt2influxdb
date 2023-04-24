# mqtt2influxdb

A node.js application that sends MQTT messages to an Influx database.

It uses a combination of regular expressions and mustache templates to offer a very flexible mechanism to transform both the MQTT topics and messages into Influx measurements, fields and tags.

All configuration is done in a single `config.yaml` file.

## Libraries

It uses the following libraries:

1. mqtt for node.js (https://www.npmjs.com/package/mqtt)
2. node-influx (https://www.npmjs.com/package/influx)
3. mustache.js (https://www.npmjs.com/package/mustache)

## Configuration of InfluxDB and MQTT connections

The **influx:** section is passed straight to InfluxDB constructor of the node-influx library (https://node-influx.github.io/class/src/index.js~InfluxDB.html).

```javascript
const influx = new Influx.InfluxDB(config.influx);
```

The **mqtt:** section is passed to the `connect` method of the mqtt class of the mqtt library:

```javascript
let mqttClient = mqtt.connect(config.mqtt.url, config.mqtt.options);
```


## MQTT topic subscriptions

The **topics:** section lists the MQTT topics we will subscribe to.

## Rewrite configuration

Actual specification of how MQTT messages are forwarded to the Influx DB database are configured in the **rewrites:** section.

This is an example **rewrites** section with 2 rewrite rules:

```yaml
rewrites:
    - regex: '(knx)\/(status)\/(.*\D.*)\/(.*\D.*)\/(.*\D.*)'
      measurement: '{{T.3}}.{{T.4}}'
      timestamp: '{{M.ts}}'
      tags:
        label: '{{T.5}}'
        dstgad: '{{{M.dstgad}}}'
      fields:
        value: '{{M.val}}'
      continue: true
    - regex: 'test\/(.*)'
      measurement: '{{T.1}}'
      tags:
        label: 'label{{T.1}}{{M.label}}'
      fields:
        f: 'value{{{T.1}}}{{M.label}}'
```

Every rewrite rule must have at least a **regex**, **measurement** and **fields** section. The **timestamp**, **tags** and **continue** sections are optional.

### Regex

Every messages send to one of the topics we subscribed to in the **topics:** section is passed through each rewrite rule.

First, the topic of the MQTT message if validated against the provided **regex** string. If it matches, the MQTT message will be used as input. If it does not match, it is ignored by this rewrite rule.

The values extracted from the topic by the regular expression are stored in an object `T` for later use in the mustache templates:

`{{T.1}}` will be replaced with the first regex group, `{{T.2}}` with the second, etc.

**Important:** `{{T.0}}` matches the full topic!

For example, if the MQTT message topic is **knx/status/AAA/BBB/CCC** it will match the regex of the first rewrite rule.

In the mustache expressions, `{{T.1}}` will be replaced with "knx", `{{T.2}}` with "status", `{{T.3}}` with "AAA", etc.

It does not match the second rewrite rule regex, so it is ignore for that rule.

### Mustache templates

The rest of the rewrite rule configuration is a set of small mustache templates that are used to create the measurement, timestamp, fields and tags for the Influx DB point that will be pushed to the database.

Check out the official mustache pages for more information on how mustache works: http://mustache.github.io/.

However, I think it is sufficient to know that

- `{{T.#}}` is replaced with the regex group # in the provided regex as explained above
- `{{M.key}}` is replaced with the *value* of the message field with name *key*

Mustache will automatically HTMl encode any "HTML" special characters like "<", ">", "&", etc.
If you do not want this escaping to happen, you should use three curly brackets, like `{{{M.key}}}`.

### Mustache Wax

Two mathematical functions have been added, based on the project
https://github.com/jvitela/mustache-wax

To use them, use the following mustache template string: `{{M.test | multiply:1000}}`. This will return the multiplication of the value of `M.test` with 1000.

### MQTT message payload

The tool accepts two types of MQTT message payloads:

1. A JSON string
2. A string representing a *number* (e.g., "15" or "15.25")

MQTT messages that do not fall in either of these categories are ignored.

In case it is a JSON string, the message is parsed into a Javascript object `M` and the values contained inside can be accessed using `M.key` in the mustache templates. It supports nested structures and array (access the first element of an array using `M.array.0`)

In case it is a string representing a number, it can be accessed using simply `M` in the mustache templates.

For example, if the MQTT message, with topic **knx/status/AAA/BBB/CCC** has this message:
```javascript
{
    'srcphy'    :   '1.1.0',
    'dstgad'    :   '0/1/2',
    'ts'        :   1543434592311,
    'lc'        :   1543434590311,
    'main'      :   'Lights',
    'middle'    :   'Set',
    'sub'       :   'Bathroom',
    'dpt'       :   'DPT1.001',
    'val'       :   1
}
```
The rewrite rule above would result in these values to be send to InfluxDB:
```javascript
    measurement: 'AAA.BBB'
    timestamp: 1543434592311000000   // timestamps are nanoseconds in InfluxDB
    tags:
       label: 'CCC'
       dstgad: '0/1/2'
    fields:
        value: 1
```

### 'numeric' fields and tags

The field or tag that can be converted into a number after the mustache template has been evaluated, is always converted into a number before sending in to InfluxDB. Measurements will always be strings.

### timestamp

The **timestamp** (optional) **must** be provided as number of milliseconds since Jan 1, 1970, 00:00:00.000 GMT (so the Unix Timestamp in *milliseconds*). It is converted automatically in *nanoseconds* by the tool.

If it is provided, it will be used by IndexDB as the timestamp of the event.

If it is not provided then InfluxDB will use the current time as timestamp of the event (default InfluxDB behaviour).

### continue

Rewrite rules are parsed from top to bottom (as present in the config file).

By default, when a matching topic for a particular rewrite is found, parsing will *stop*. This means that rewrite rules further down are no longer taken into account. If you wish to continue looking for matches, then just set `continue: true` in the rewrite and the parser will continue looking for other matches of the topic, possibly resulting in multiple entries in InfluxDB.

The idea is that you put very specific topics high in the rewrite list and more generic (wildcard) topics further down. This allows you to create a specific rule for a couple of topics and more 'catch-all' topics for all other topics. Since the parser will stop parsing after the first match, you do not have to worry about multiple entries being pushed to InfluxDB.
### retained messages

By default, retained messages will **not** be sent to Influx DB. So when starting mqtt2influxdb, all messages that were retained by the MQTT broker are ignored. This is to prevent duplicate injections after a restart.

If you do want to send retained messages to Influx DB, you can enabled this by putting `retained: true` in the config file.
