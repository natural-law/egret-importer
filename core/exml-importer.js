'use strict';

const Async = require('async');
const Path = require('path');
const Fs = require('fire-fs');

function importExmlFiles(exmlFiles, resInfo, srcResPath, tempResPath, targetRootUrl, cb) {

    if (cb) {
        cb();
    }
}

module.exports = {
    importExmlFiles: importExmlFiles
};
