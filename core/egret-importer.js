'use strict';

function importProject(projPath, cb) {
    Editor.log('Importing project %s', projPath);
    cb();
}

module.exports = {
    name: 'Egret',
    exts: null,
    importer: importProject
};
