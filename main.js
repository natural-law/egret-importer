'use strict';

var EgretImporter = require('./core/egret-importer');

module.exports = {
  load () {
    Editor.Ipc.sendToMain('project-importer:register-importer', EgretImporter.name, EgretImporter.exts, 'packages://egret-importer/core/egret-importer');
  },

  unload () {
    Editor.Ipc.sendToMain('project-importer:unregister-importer', EgretImporter.name);
  }
};
