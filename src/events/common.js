function compactObject(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function firstPresent(...values) {
    return values.find(value => value !== undefined && value !== null && value !== '');
}

function stripPrivateFields(eventPayload) {
    return Object.fromEntries(Object.entries(eventPayload).filter(([key]) => !key.startsWith('_')));
}

module.exports = {
    compactObject,
    firstPresent,
    stripPrivateFields,
};
