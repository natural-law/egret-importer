'use strict';

const Path = require('path');
const Fs = require('fire-fs');
const Url = require('fire-url');
const Async = require('async');
const Plist = require('plist');
const ExmlImporter = require('./exml-importer');
const MD5 = require('md5');

const AssetsRootUrl = 'db://assets';
const ResFolderName = 'resource';
const TempFolderName = 'temp';
const ACTION_FOLDER_SUFFIX = '_action';
const ACTION_NODE_NAME = 'sprite';
const TEMP_FILES_SUFFIX = '_temp';

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
    },
    'plist_cfg' : function (jsonObj) {
        return (jsonObj.file && jsonObj.frames);
    }
};

function importProject(projPath, cb) {
    Editor.log('Importing Egret project : %s', projPath);
    _trackEvent('Import begin');
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
                //Editor.assetdb.remote.watchOFF();
                //Editor.assetdb.remote._tasks.push({
                //    name: 'import-egret-assets',
                //    run: _importAssets,
                //    params: [],
                //    silent: true
                //}, function(needRefreshUrls) {
                //    if (!needRefreshUrls || needRefreshUrls.length === 0) {
                //        return next();
                //    }
                //
                //    var index = 0;
                //    Async.whilst(
                //        function() {
                //            return index < needRefreshUrls.length;
                //        },
                //        function(callback) {
                //            Editor.assetdb.refresh(needRefreshUrls[index], function() {
                //                index++;
                //                callback();
                //            });
                //        },
                //        function() {
                //            next();
                //        }
                //    );
                //});
                //Editor.assetdb.remote.watchON();
                _importAssets();
                next();
            },
            function(next) {
                if (!Fs.existsSync(tempResPath)) {
                    return next();
                }

                // import files in tempResPath
                Editor.assetdb.import([tempResPath], AssetsRootUrl, false, function() {
                    _removeTempResPath();
                    _removeTempFilesPath();
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

                // create the folders for the exmlFiles
                for (var i = 0, n = exmlFiles.length; i < n; i++) {
                    var exmlPath = exmlFiles[i];
                    var relativeDir = Path.relative(resourcePath, Path.dirname(exmlPath));
                    var checkPath = Path.join(tempPrefabPath, relativeDir);
                    Fs.ensureDirSync(checkPath);
                }

                // import the temp prefab path
                Editor.assetdb.import([tempPrefabPath], AssetsRootUrl, false, function(err, results) {
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
            _removeTempFilesPath();
            cb();
        });
    } catch (err) {
        // TODO remove temp path if error occurred???
        //_removeTempResPath();

        cb(new Error('Import resource files failed.'));
        if (err) {
            _trackEvent('Import failed');
        } else {
            _trackEvent('Import success');
        }
    }
}

function _importAssets(assetdb, cb) {
    var needRefreshUrls = [];
    _copyResources(resourcePath, needRefreshUrls);
    var animFiles = jsonFiles.anim_cfg;
    if (!animFiles || animFiles.length === 0) {
        if (cb) {
            cb(needRefreshUrls);
        }
        return;
    }

    // generate plist file for the animation frames
    for (var idx in animFiles) {
        _genPlistForAnim(animFiles[idx], needRefreshUrls);
    }

    if (cb) {
        cb(needRefreshUrls);
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

function _removeTempFilesPath() {
    var tempFilesPath = Path.join(Editor.remote.projectPath, TempFolderName, projectName + TEMP_FILES_SUFFIX);
    try {
        _rmdirRecursive(tempFilesPath);
    } catch (err) {
        Editor.warn('Delete temp path %s failed, please delete it manually!', tempFilesPath);
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

function _handleJsonFile(absPath, needRefreshUrls) {
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
        if (jsonType === 'plist_cfg') {
            // is a plist format file, convert to plist
            _handlePlistFile(absPath, needRefreshUrls);
            return;
        }

        if (! jsonFiles[jsonType]) {
            jsonFiles[jsonType] = [];
        }
        jsonFiles[jsonType].push(absPath);
    } else {
        // copy to the target path
        _handleFile(absPath, needRefreshUrls);
    }
}

function _handlePlistFile(absPath, needRefreshUrls) {
    var fileContent = Fs.readFileSync(absPath, 'utf8');
    var fileObj = JSON.parse(fileContent);
    var plistObj = {
        metadata : {
            format: 2,
            realTextureFileName: fileObj.file,
            textureFileName: fileObj.file
        },
        frames : {

        }
    };

    var imgWidth = 0, imgHeight = 0;
    for (var frameKey in fileObj.frames) {
        if (! fileObj.frames.hasOwnProperty(frameKey)) {
            continue;
        }

        var frameCfg = fileObj.frames[frameKey];
        plistObj.frames[frameKey] = {
            frame: `{{${frameCfg.x},${frameCfg.y}},{${frameCfg.w},${frameCfg.h}}}`,
            offset : `{{${frameCfg.offX},${frameCfg.offY}}}`,
            rotated: false,
            sourceColorRect: `{{0,0},{${frameCfg.w},${frameCfg.h}}}`,
            sourceSize: `{${frameCfg.sourceW},${frameCfg.sourceH}}`
        };

        imgWidth = Math.max(imgWidth, frameCfg.x + frameCfg.w);
        imgHeight = Math.max(imgHeight, frameCfg.y + frameCfg.h);
    }

    plistObj.metadata.size = `{${imgWidth},${imgHeight}}`;

    var plistContent = Plist.build(plistObj);
    var name = Path.basename(absPath, Path.extname(absPath));
    var srcPath = Path.join(Path.dirname(absPath), name + '.plist');
    _writeAndHandleFile(plistContent, srcPath, needRefreshUrls);
}

function _handleFntFile(absPath, needRefreshUrls) {
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

        _writeAndHandleFile(lines.join('\n'), absPath, needRefreshUrls);
    } catch (err) {
        // do nothing if error occurred
    }

    if (!customFnt) {
        // not custom fnt file, copy to the target path
        _handleFile(absPath, needRefreshUrls);
    }
}

function _writeAndHandleFile(content, srcPath, needRefreshUrls) {
    var tempFilesPath = Path.join(Editor.remote.projectPath, TempFolderName, projectName + TEMP_FILES_SUFFIX);
    var targetPath = Path.join(tempFilesPath, Path.basename(srcPath));
    if (Fs.existsSync(targetPath)) {
        Fs.unlinkSync(targetPath);
    }

    Fs.ensureDirSync(tempFilesPath);
    Fs.writeFileSync(targetPath, content);

    var relativePath = Path.relative(resourcePath, srcPath);
    _handleFile(targetPath, needRefreshUrls, relativePath);
}

function _copyResources(srcPath, needRefreshUrls) {
    Fs.readdirSync(srcPath).forEach(function (file) {
        var absPath = Path.join(srcPath, file);
        var relativePath = Path.relative(resourcePath, absPath);
        if(Fs.lstatSync(absPath).isDirectory()) {
            // recurse
            _copyResources(absPath, needRefreshUrls);
        } else {
            var ext = Path.extname(absPath);
            if (ext === '.exml') {
                exmlFiles.push(absPath);
            } else if (ext === '.json'){
                _handleJsonFile(absPath, needRefreshUrls);
            } else if (ext === '.fnt') {
                _handleFntFile(absPath, needRefreshUrls);
            } else {
                _handleFile(absPath, needRefreshUrls);
            }
        }
    });
}

function _handleFile(filePath, needRefreshUrls, relativePath) {
    var resPath = Editor.assetdb.remote._fspath(newResourceUrl);
    var copy2Temp = false;
    var needRefresh = false;
    if (!relativePath) {
        relativePath = Path.relative(resourcePath, filePath);
    }

    if (Fs.existsSync(resPath)) {
        var checkPath = Path.join(resPath, relativePath);
        if (!Fs.existsSync(checkPath)) {
            copy2Temp = true;
        } else {
            if (!_isSame(checkPath, filePath)) {
                needRefresh = true;
            }
        }
    } else {
        copy2Temp = true;
    }

    if (copy2Temp) {
        var dstPath = Path.join(tempResPath, relativePath);
        Fs.ensureDirSync(Path.dirname(dstPath));
        Fs.copySync(filePath, dstPath);
    }
    else if (needRefresh) {
        // Warning not copy the file to the assets folder

        //Fs.copySync(filePath, checkPath);
        //needRefreshUrls.push(Editor.assetdb.remote._url(checkPath));
    }
}

function _isSame(file1, file2) {
    var md51 = MD5(Fs.readFileSync(file1));
    var md52 = MD5(Fs.readFileSync(file2));
    return md51 === md52;
}

// import animation files
function _importAnimFiles(cb) {
    var animFiles = jsonFiles.anim_cfg;
    if (!animFiles || animFiles.length === 0) {
        cb();
        return;
    }

    Async.waterfall([
        function(next) {
            // create the folders for the animation files
            for (var i = 0, n = animFiles.length; i < n; i++) {
                var relativeDir = Path.relative(resourcePath, Path.dirname(animFiles[i]));
                var checkPath = Path.join(tempPrefabPath, relativeDir);
                Fs.ensureDirSync(checkPath);
            }

            // import the temp prefab path
            Editor.assetdb.import([tempPrefabPath], AssetsRootUrl, false, function(err, results) {
                next();
            });
        },
        function(next) {
            _asynHandleList(animFiles, function(animFile, cb) {
                // generate the anim files for Creator
                var usingAnimUrls = _genAnimFile(animFile);
                if (!usingAnimUrls || usingAnimUrls.length === 0) {
                    return cb();
                }

                // get the paths for importing
                var name = Path.basename(animFile, Path.extname(animFile));
                var relativeDir = Path.relative(resourcePath, Path.dirname(animFile));
                var animFolderPath = Path.join(tempPrefabPath, relativeDir, name + ACTION_FOLDER_SUFFIX);
                var targetUrl = Url.join(newPrefabUrl, relativeDir);

                Async.waterfall([
                    next => {
                        Editor.assetdb.import([animFolderPath], targetUrl, false, function(err, results) {
                            next();
                        });
                    },
                    next => {
                        // generate prefab to use the animation Clip
                        var prefabPath = _genAnimPrefab(animFile, usingAnimUrls);
                        if (!prefabPath) {
                            return next();
                        }

                        Editor.assetdb.import([prefabPath], targetUrl, false, function(err, results) {
                            next();
                        });
                    }
                ], function() {
                    cb();
                });

            }, next);
        }
    ], function(err) {
        if (cb) {
            cb(err);
        }
    });
}

function _asynHandleList(list, handler, cb) {
    var index = 0;
    Async.whilst(
        function() {
            return index < list.length;
        },
        function(callback) {
            handler(list[index], function() {
                index++;
                callback();
            });
        },
        function() {
            cb();
        }
    );
}

function _genPlistForAnim(animFile, needRefreshUrls) {
    var name = Path.basename(animFile, Path.extname(animFile));
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

    var plistContent = Plist.build(plistObj);
    var srcPath = Path.join(Path.dirname(animFile), name + '.plist');
    _writeAndHandleFile(plistContent, srcPath, needRefreshUrls);
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
        return null;
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

    return prefabPath;
}

function _trackEvent(action) {
    Editor.Ipc.sendToMain('metrics:track-event', {
        category: 'Packages',
        label: 'egret-importer',
        action: action
    });
}

module.exports = {
    name: 'Egret',
    exts: null,
    importer: importProject
};
