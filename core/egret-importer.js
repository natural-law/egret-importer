'use strict';

const Path = require('path');
const Fs = require('fire-fs');
const Url = require('fire-url');
const Async = require('async');
const Plist = require('plist');
const ExmlImporter = require('./exml-importer');

const AssetsRootUrl = 'db://assets';
const ResFolderName = 'resource';
const TempFolderName = 'temp';
const ACTION_FOLDER_SUFFIX = '_action';
const ACTION_NODE_NAME = 'sprite';

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
                // import animation assets
                _importAnimFiles(function (err) {
                    if (err) {
                        next(err);
                        return;
                    }

                    _removeTempResPath();
                    next();
                });
            },
            function(next) {
                if (exmlFiles.length === 0) {
                    // there isn't any exmls
                    next();
                    return;
                }

                // collect the skins config
                var skins = {};
                for (var thmCfgIdx in jsonFiles.thm_cfg) {
                    var thmFile = jsonFiles.thm_cfg[thmCfgIdx];
                    var thmObj = JSON.parse(Fs.readFileSync(thmFile, 'utf8'));
                    for (var skinKey in thmObj.skins) {
                        skins[skinKey] = thmObj.skins[skinKey];
                    }
                }

                // filter the exml files, separate the skins & normal exmls.
                var needImportExmls = {
                    'skins' : {},
                    'others' : []
                };
                for (var exmlIdx in exmlFiles) {
                    var skinName = null;
                    var exmlPath = exmlFiles[exmlIdx];
                    for (var skinIdx in skins) {
                        var fullPath = Path.normalize(Path.join(projectPath, skins[skinIdx]));
                        if (exmlPath === fullPath) {
                            skinName = skinIdx;
                            break;
                        }
                    }

                    if (skinName) {
                        needImportExmls.skins[skinName] = exmlPath;
                    } else {
                        needImportExmls.others.push(exmlPath);
                    }
                }

                // collect the resource info
                var resInfo = {};
                for (var resCfgIdx in jsonFiles.res_cfg) {
                    var resFile = jsonFiles.res_cfg[resCfgIdx];
                    var resObj = JSON.parse(Fs.readFileSync(resFile, 'utf8'));
                    for (var resInfoIdx in resObj.resources) {
                        var resItemInfo = resObj.resources[resInfoIdx];
                        resInfo[resItemInfo.name] = resItemInfo.url;
                    }
                }

                // import exml files
                ExmlImporter.importExmlFiles(needImportExmls, resInfo, resourcePath, tempResPath, newResourceUrl, next);
            }
        ], function (err) {
            if (err) {
                cb(err);
                return;
            }

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
        jsonFiles[jsonType].push(absPath);
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

// import animation files
function _importAnimFiles(cb) {
    var animFiles = jsonFiles.anim_cfg;
    if (!animFiles || animFiles.length === 0) {
        cb();
        return;
    }

    var animUrls = {};
    Async.waterfall([
        function(next) {
            // generate plist file for frames
            for (var idx in animFiles) {
                _genPlistForAnim(animFiles[idx]);
            }

            // import plist files
            Editor.assetdb.import([tempResPath], AssetsRootUrl, false, function(err, results) {
                _removeTempResPath();
                next();
            });
        },
        function(next) {
            // generate the anim files for Creator
            for (var idx in animFiles) {
                var animFile = animFiles[idx];
                animUrls[animFile] = _genAnimFile(animFile);
            }

            // import anim files
            Editor.assetdb.import([tempResPath], AssetsRootUrl, false, function(err, results) {
                _removeTempResPath();
                next();
            });
        },
        function(next) {
            // generate prefab to use the animation Clip
            for (var idx in animFiles) {
                var animFile = animFiles[idx];
                _genAnimPrefab(animFile, animUrls[animFile]);
            }

            // import prefab files
            Editor.assetdb.import([tempResPath], AssetsRootUrl, false, function(err, results) {
                _removeTempResPath();
                next();
            });
        }
    ], function(err) {
        if (cb) {
            cb(err);
        }
    });
}

function _genPlistForAnim(animFile) {
    var name = Path.basename(animFile, Path.extname(animFile));
    var relativeDir = Path.relative(resourcePath, Path.dirname(animFile));
    var plistPath = Path.join(tempResPath, relativeDir, name + '.plist');
    var pngName = name + '.png';

    var animCfg = JSON.parse(Fs.readFileSync(animFile, 'utf8'));
    var plistObj = {
        metadata : {
            format: 2,
            realTextureFileName: pngName,
            textureFileName: pngName
        },
        frames : {

        }
    };

    var imgWidth = 0, imgHeight = 0;
    for (var frameKey in animCfg.res) {
        if (! animCfg.res.hasOwnProperty(frameKey)) {
            continue;
        }

        var frameCfg = animCfg.res[frameKey];
        plistObj.frames[frameKey] = {
            frame: `{{${frameCfg.x},${frameCfg.y}},{${frameCfg.w},${frameCfg.h}}}`,
            offset : '{0,0}',
            rotated: false,
            sourceColorRect: `{{0,0},{${frameCfg.w},${frameCfg.h}}}`,
            sourceSize: `{${frameCfg.w},${frameCfg.h}}`
        };

        imgWidth = Math.max(imgWidth, frameCfg.x + frameCfg.w);
        imgHeight = Math.max(imgHeight, frameCfg.y + frameCfg.h);
    }

    plistObj.metadata.size = `{${imgWidth},${imgHeight}}`;

    var plistDir = Path.dirname(plistPath);
    if (!Fs.existsSync(plistDir)) {
        Fs.mkdirsSync(plistDir);
    }

    var plistContent = Plist.build(plistObj);
    Fs.writeFileSync(plistPath, plistContent);
}

function _genAnimFile(animFile) {
    var name = Path.basename(animFile, Path.extname(animFile));
    var relativeDir = Path.relative(resourcePath, Path.dirname(animFile));
    var plistUrl = Url.join(newResourceUrl, relativeDir, name + '.plist');

    var animFolderPath = Path.join(tempResPath, relativeDir, name + ACTION_FOLDER_SUFFIX);
    var animCfg = JSON.parse(Fs.readFileSync(animFile, 'utf8'));

    // create animation clip files
    var importedUrls = [];
    for (var animName in animCfg.mc) {
        var animInfo = animCfg.mc[animName];
        var framesInfo = animInfo.frames;
        // if there only 1 frame, it's not necessary to generate animation
        if (!framesInfo || framesInfo.length <= 1) {
            continue;
        }

        var curveData = { paths : {} };
        curveData.paths[ACTION_NODE_NAME] = {
            comps : {
                'cc.Sprite' : {
                    spriteFrame : []
                }
            },
            props : {
                position: []
            }
        };

        var oneFrameDuration = 1 / animInfo.frameRate;
        for (var frameIdx in framesInfo) {
            var frameCfg = framesInfo[frameIdx];
            var frameValue = frameIdx * oneFrameDuration;

            // generate position frames
            curveData.paths[ACTION_NODE_NAME].props.position.push(
                { frame: frameValue, value : [frameCfg.x, -frameCfg.y] }
            );

            // generate spriteFrame frames
            var frameUrl = Url.join(plistUrl, frameCfg.res);
            var uuid = Editor.assetdb.remote.urlToUuid(frameUrl);
            if (Editor.assetdb.remote.existsByUuid(uuid)) {
                var frame = new cc.SpriteFrame();
                frame._uuid = uuid;
                curveData.paths[ACTION_NODE_NAME].comps['cc.Sprite'].spriteFrame.push(
                    { frame: frameValue, value : frame }
                );
            }
        }

        var animFilePath = Path.join(animFolderPath, animName + '.anim');
        var animClip = new cc.AnimationClip();
        animClip.sample = animInfo.frameRate;
        animClip._name = animName;
        animClip._duration = oneFrameDuration * (animInfo.frames.length - 1);
        animClip.curveData = curveData;
        var animClipStr = Editor.serialize(animClip);

        if (!Fs.existsSync(animFolderPath)) {
            Fs.mkdirsSync(animFolderPath);
        }
        Fs.writeFileSync(animFilePath, animClipStr);

        importedUrls.push(Url.join(newResourceUrl, relativeDir, name + ACTION_FOLDER_SUFFIX, animName + '.anim'));
    }

    return importedUrls;
}

function _genAnimPrefab(animFile, animUrls) {
    if (!animUrls || animUrls.length === 0) {
        return;
    }

    // create prefab to use the animation clips
    var name = Path.basename(animFile, Path.extname(animFile));
    var relativeDir = Path.relative(resourcePath, Path.dirname(animFile));
    var prefabPath = Path.join(tempResPath, relativeDir, name + '.prefab');
    var node = new cc.Node('node');
    var spNode = new cc.Node(ACTION_NODE_NAME);
    node.addChild(spNode);
    spNode.addComponent(cc.Sprite);

    var animateComponent = node.addComponent(cc.Animation);
    if (!animateComponent) {
        Editor.warn('Add Animation component failed.');
    } else {
        // set properties for animation component
        for (var i = 0, n = animUrls.length; i < n; i++) {
            var clipUrl = animUrls[i];
            var uuid = Editor.assetdb.remote.urlToUuid(clipUrl);
            if (!uuid) {
                continue;
            }

            var animClip = new cc.AnimationClip();
            animClip._uuid = uuid;
            animClip._name = Url.basenameNoExt(clipUrl);
            animateComponent.addClip(animClip);

            // set the default animation clip
            //if (0 === i) {
            //    animateComponent.defaultClip = animClip;
            //    animateComponent.playOnLoad = true;
            //}
        }
    }

    var prefabDir = Path.dirname(prefabPath);
    if (!Fs.existsSync(prefabDir)) {
        Fs.mkdirsSync(prefabDir);
    }

    var prefab = _Scene.PrefabUtils.createPrefabFrom(node);
    var prefabData = Editor.serialize(prefab);
    Fs.writeFileSync(prefabPath, prefabData);
}

module.exports = {
    name: 'Egret',
    exts: null,
    importer: importProject
};
