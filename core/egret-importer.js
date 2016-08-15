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
var tempPrefabPath = '';
var projectPath = '';
var resourcePath = '';
var newResourceUrl = '';
var newPrefabUrl = '';
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
        newPrefabUrl = newResourceUrl;
        var i = 1;
        while (Fs.existsSync(Editor.assetdb.remote._fspath(newPrefabUrl))) {
            newPrefabUrl = Url.join(AssetsRootUrl, projectName + '_' + i);
            i++;
        }

        var folderName = Url.basename(newResourceUrl);
        tempResPath = Path.join(Editor.remote.projectPath, TempFolderName, folderName);
        folderName = Url.basename(newPrefabUrl);
        tempPrefabPath = Path.join(Editor.remote.projectPath, TempFolderName, folderName);
    } catch (err) {
        return cb(err);
    }

    // import the resource files
    try {
        Async.waterfall([
            function(next) {
                Editor.assetdb.remote.watchOFF();
                Editor.assetdb.remote._tasks.push({
                    name: 'import-egret-assets',
                    run: _importAssets,
                    params: [],
                    silent: true
                }, function() {
                    next();
                });
            },
            function(next) {
                Editor.assetdb.refresh(newResourceUrl, function() {
                    Editor.assetdb.remote.watchON();
                    next();
                });
            },
            function(next) {
                // import animation assets
                _importAnimFiles(function (err) {
                    next(err);
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
                ExmlImporter.importExmlFiles(needImportExmls, resInfo, resourcePath, tempPrefabPath, newResourceUrl, newPrefabUrl, next);
            }
        ], function (err) {
            if (err) {
                cb(err);
                return;
            }

            Editor.log('Import Egret project finished.');
            Editor.log('Resources are imported to folder : %s', newPrefabUrl);

            _removeTempResPath();
            _removeTempPrefabPath();
            cb();
        });
    } catch (err) {
        // TODO remove temp path if error occurred???
        //_removeTempResPath();

        cb(new Error('Import resource files failed.'));
    }
}

function _importAssets(assetdb, cb) {
    var newResPath = Editor.assetdb.remote.urlToFspath(newResourceUrl);
    _copyResources(resourcePath, newResPath, resourcePath);
    var animFiles = jsonFiles.anim_cfg;
    if (!animFiles || animFiles.length === 0) {
        if (cb) {
            cb();
        }
        return;
    }

    // generate plist file for the animation frames
    for (var idx in animFiles) {
        _genPlistForAnim(animFiles[idx]);
    }

    if (cb) {
        cb();
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

function _removeTempResPath() {
    try {
        _rmdirRecursive(tempResPath);
    } catch (err) {
        Editor.warn('Delete temp path %s failed, please delete it manually!', tempResPath);
    }
}

function _removeTempPrefabPath() {
    try {
        _rmdirRecursive(tempPrefabPath);
    } catch (err) {
        Editor.warn('Delete temp path %s failed, please delete it manually!', tempPrefabPath);
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
        Fs.copySync(absPath, targetPath);
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
            var xadvance = frame.xadvance || frameCfg.sourceW || frameCfg.w;
            var charLine = `char id=${charCode} x=${frameCfg.x} y=${frameCfg.y} width=${frameCfg.w} height=${frameCfg.h} xoffset=${frameCfg.offX} yoffset=${frameCfg.offY} xadvance=${xadvance} page=0 chnl=0`;
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
        Fs.copySync(absPath, targetPath);
    }
}

function _copyResources(srcPath, dstPath, resRoot) {
    Fs.readdirSync(srcPath).forEach(function (file) {
        var absPath = Path.join(srcPath, file);
        var targetPath = Path.join(dstPath, file);
        if(Fs.lstatSync(absPath).isDirectory()) {
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
                Fs.ensureDirSync(dstPath);
                Fs.copySync(absPath, targetPath);
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
            // generate the anim files for Creator
            for (var idx in animFiles) {
                var animFile = animFiles[idx];
                animUrls[animFile] = _genAnimFile(animFile);
            }

            // import anim files
            Editor.assetdb.import([tempPrefabPath], AssetsRootUrl, false, function(err, results) {
                _removeTempPrefabPath();
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
            Editor.assetdb.import([tempPrefabPath], AssetsRootUrl, false, function(err, results) {
                _removeTempPrefabPath();
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
    var newResPath = Editor.assetdb.remote.urlToFspath(newResourceUrl);
    var plistPath = Path.join(newResPath, relativeDir, name + '.plist');
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

    Fs.ensureDirSync(Path.dirname(plistPath));
    var plistContent = Plist.build(plistObj);
    Fs.writeFileSync(plistPath, plistContent);
}

function _genAnimFile(animFile) {
    var name = Path.basename(animFile, Path.extname(animFile));
    var relativeDir = Path.relative(resourcePath, Path.dirname(animFile));
    var plistUrl = Url.join(newResourceUrl, relativeDir, name + '.plist');

    var animFolderPath = Path.join(tempPrefabPath, relativeDir, name + ACTION_FOLDER_SUFFIX);
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

        Fs.ensureDirSync(animFolderPath);
        Fs.writeFileSync(animFilePath, animClipStr);

        importedUrls.push(Url.join(newPrefabUrl, relativeDir, name + ACTION_FOLDER_SUFFIX, animName + '.anim'));
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
    var prefabPath = Path.join(tempPrefabPath, relativeDir, name + '.prefab');
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

    Fs.ensureDirSync(Path.dirname(prefabPath));
    var prefab = _Scene.PrefabUtils.createPrefabFrom(node);
    var prefabData = Editor.serialize(prefab);
    Fs.writeFileSync(prefabPath, prefabData);
}

module.exports = {
    name: 'Egret',
    exts: null,
    importer: importProject
};
