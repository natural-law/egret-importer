'use strict';

const Path = require('path');
const Fs = require('fire-fs');
const Url = require('fire-url');
const Async = require('async');

const AssetsRootUrl = 'db://assets';
const ResFolderName = 'resource';
const TempFolderName = 'temp';

var tempResPath = '';
var projectPath = '';
var resourcePath = '';
var newResourceUrl = '';
var projectName = '';
var jsonFiles = {};
var exmlFiles = [];

const JSON_CHECKERS = {
    'res_cfg' : function (jsonObj) {
        return (jsonObj.groups && jsonObj.groups instanceof Array &&
                jsonObj.resources && jsonObj.resources instanceof Array);
    },
    'thm_cfg' : function (jsonObj) {
        return (jsonObj.skins && jsonObj.exmls && jsonObj.exmls instanceof Array);
    },
    'anim_cfg' : function (jsonObj) {
        return (jsonObj.mc && jsonObj.res);
    }
};

function importProject(projPath, cb) {
    Editor.log('Importing Egret project : %s', projPath);
    projectPath = projPath;
    projectName = Path.basename(projPath);
    resourcePath = Path.join(projectPath, ResFolderName);
    if (!Fs.existsSync(resourcePath) || !Fs.isDirSync(resourcePath)) {
        cb(new Error(`Resource directory ${resourcePath} is not existed.`));
        return;
    }

    // get the new resource url for imported project
    try {
        newResourceUrl = Url.join(AssetsRootUrl, projectName);
        var i = 1;
        while (Fs.existsSync(Editor.assetdb.remote._fspath(newResourceUrl))) {
            newResourceUrl = Url.join(AssetsRootUrl, projectName + '_' + i);
            i++;
        }
    } catch (err) {
        return cb(err);
    }

    // create temp path
    _createTempResPath();

    // import the resource files
    try {
        // create a folder with project name in assets
        _createAssetFolder(resourcePath);

        _copyResources(resourcePath, tempResPath, resourcePath);

        Async.waterfall([
            function(next) {
                // import raw assets
                Editor.assetdb.import([tempResPath], AssetsRootUrl, false, function(err, results) {
                    _removeTempResPath();
                    next();
                });
            },
            function(next) {
                // TODO import exml files
                next();
            },
            function(next) {
                // TODO import animation files
                next();
            }
        ], function () {
            Editor.log('Import Egret project finished.');
            Editor.log('Resources are imported to folder : %s', newResourceUrl);

            _removeTempResPath();
            cb();
        });
    } catch (err) {
        // TODO remove temp path if error occurred???
        //_removeTempResPath();

        cb(new Error('Import resource files failed.'));
    }
}

function _rmdirRecursive (path) {
    if( Fs.existsSync(path) ) {
        Fs.readdirSync(path).forEach(function(file){
            var curPath = Path.join(path, file);
            if(Fs.lstatSync(curPath).isDirectory()) { // recurse
                _rmdirRecursive(curPath);
            } else { // delete file
                Fs.unlinkSync(curPath);
            }
        });
        Fs.rmdirSync(path);
    }
}

function _createTempResPath() {
    // create a temp path for import project
    var folderName = Url.basename(newResourceUrl);
    tempResPath = Path.join(Editor.remote.projectPath, TempFolderName, folderName);
    if (Fs.existsSync(tempResPath)) {
        _rmdirRecursive(tempResPath);
    }

    Fs.mkdirsSync(tempResPath);
}

function _removeTempResPath() {
    try {
        _rmdirRecursive(tempResPath);
    } catch (err) {
        Editor.warn('Delete temp path %s failed, please delete it manually!', tempResPath);
    }
}

function _createAssetFolder(folderPath) {
    var relativePath = Path.relative(resourcePath, folderPath);
    var newFsPath = Path.join(tempResPath, relativePath);
    if (!Fs.existsSync(newFsPath)) {
        Fs.mkdirsSync(newFsPath);
    }
}

function _handleJsonFile(absPath, targetPath) {
    // json files should be separated with type
    var fileContent = Fs.readFileSync(absPath, 'utf8');
    var jsonType = null;
    try {
        var obj = JSON.parse(fileContent);
        for (var type in JSON_CHECKERS) {
            if (!JSON_CHECKERS.hasOwnProperty(type)) {
                continue;
            }

            var checker = JSON_CHECKERS[type];
            if (checker && checker(obj)) {
                jsonType = type;
                break;
            }
        }
    } catch(err) {
        // not a valid json file, treat it as a raw data file
        // nothing to do
    }

    if (jsonType) {
        if (! jsonFiles[jsonType]) {
            jsonFiles[jsonType] = [];
        }
        jsonFiles[jsonType].push(obj);
    } else {
        // copy to the target path
        if (!Fs.existsSync(targetPath)) {
            Fs.copySync(absPath, targetPath);
        }
    }
}

function _handleFntFile(absPath, targetPath) {
    // should convert the fnt file if it's a json
    var customFnt = false;
    try {
        var fntContent = Fs.readFileSync(absPath, 'utf8');
        var fntObj = JSON.parse(fntContent);
        customFnt = true;

        // convert the custom fnt file to classic fnt file
        var fSize = 0, lineHeight = 0;
        var charList = [];
        for (var frame in fntObj.frames) {
            if (! fntObj.frames.hasOwnProperty(frame)) {
                continue;
            }

            var frameCfg = fntObj.frames[frame];
            fSize = Math.max(fSize, frameCfg.w);
            lineHeight = Math.max(lineHeight, frameCfg.h);
            var charCode = frame.charCodeAt(0);
            var charLine = `char id=${charCode} x=${frameCfg.x} y=${frameCfg.y} width=${frameCfg.w} height=${frameCfg.h} xoffset=${frameCfg.offX} yoffset=${frameCfg.offY} xadvance=0 page=0 chnl=0`;
            charList.push(charLine);
        }

        var face = Path.basename(absPath, Path.extname(absPath));
        var file = fntObj.file;
        var lines = [];

        // format the info line
        lines[0] = `info face="${face}" size=${fSize} bold=0 italic=0 charset="" unicode=0 stretchH=100 smooth=1 aa=1 padding=0,0,0,0 spacing=1,1`;
        // format the common line
        lines[1] = `common lineHeight=${lineHeight} base=0 scaleW=0 scaleH=0 pages=1 packed=0`;
        // format the page line
        lines[2] = `page id=0 file="${file}"`;
        // format the char count line
        lines[3] = `chars count=${charList.length}`;
        lines = lines.concat(charList);

        Fs.writeFileSync(targetPath, lines.join('\n'));
    } catch (err) {
        // do nothing if error occurred
    }

    if (!customFnt) {
        // not custom fnt file, copy to the target path
        if (!Fs.existsSync(targetPath)) {
            Fs.copySync(absPath, targetPath);
        }
    }
}

function _copyResources(srcPath, dstPath, resRoot) {
    Fs.readdirSync(srcPath).forEach(function (file) {
        var absPath = Path.join(srcPath, file);
        var targetPath = Path.join(dstPath, file);
        if(Fs.lstatSync(absPath).isDirectory()) {
            if (!Fs.existsSync(targetPath)) {
                Fs.mkdirsSync(targetPath);
            }

            // recurse
            _copyResources(absPath, targetPath, resRoot);
        } else {
            var ext = Path.extname(absPath);
            if (ext === '.exml') {
                exmlFiles.push(absPath);
            } else if (ext === '.json'){
                _handleJsonFile(absPath, targetPath);
            } else if (ext === '.fnt') {
                _handleFntFile(absPath, targetPath);
            } else {
                if (!Fs.existsSync(targetPath)) {
                    Fs.copySync(absPath, targetPath);
                }
            }
        }
    });
}

module.exports = {
    name: 'Egret',
    exts: null,
    importer: importProject
};
