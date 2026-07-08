'use strict';

function flagsForRunMode(mode) {
    switch (mode) {
        case 'run':
            return ['--run'];
        case 'agent':
            return ['--agent'];
        case 'generate':
        case '':
        case null:
        case undefined:
            return [];
        default:
            return [];
    }
}

module.exports = { flagsForRunMode };
