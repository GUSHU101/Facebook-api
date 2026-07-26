const JSONBigInt = require('json-bigint');

const strictLargeIntegerParser = JSONBigInt({
    storeAsString: true,
    strict: true,
    protoAction: 'error',
    constructorAction: 'error',
});

function parseJsonPreservingLargeIntegers(value) {
    return strictLargeIntegerParser.parse(String(value));
}

module.exports = { parseJsonPreservingLargeIntegers };
