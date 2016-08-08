'use strict';

const Async = require('async');
const Path = require('path');
const Fs = require('fire-fs');
const Url = require('fire-url');
const DOMParser = require('xmldom').DOMParser;
const XmlUtils = require('./xml-utils');

const WidgetImporters = {
    'Button' : _importButton
};

const ChildCheckers = {
    'Button' : _noChildChecker,
    'Label' : _noChildChecker,
    'Image' : _noChildChecker
};

var skinPathToKey = null;
var SkinsInfo = null;
var ResInfo = null;
var RootUrl = null;
var SrcResPath = null;
var TempResPath = null;

var importedExmls = [];

function importExmlFiles(exmlFiles, resInfo, srcResPath, tempResPath, targetRootUrl, cb) {
    ResInfo = resInfo;
    RootUrl = targetRootUrl;
    SrcResPath = srcResPath;
    TempResPath = tempResPath;

    SkinsInfo = exmlFiles.skins;
    skinPathToKey = {};
    var allExmls = [];
    for (var key in SkinsInfo) {
        var skinPath = SkinsInfo[key];
        allExmls.push(skinPath);
        skinPathToKey[skinPath] = key;
    }
    allExmls = allExmls.concat(exmlFiles.others);

    // import exmls
    var index = 0;
    Async.whilst(
        function() {
            return index < allExmls.length;
        },
        function(callback) {
            _importExml(allExmls[index], function() {
                index++;
                callback();
            });
        },
        function() {
            cb();
        }
    );
}

function _getResUuidByName(resName) {
    var resPath = ResInfo[resName];
    if (!resPath || resPath.length === 0) {
        return null;
    }

    var resUrl = Url.join(RootUrl, resPath);
    var uuid = Editor.assetdb.remote.urlToUuid(resUrl);
    if (Editor.assetdb.remote.existsByUuid(uuid)) {
        return uuid;
    }

    return null;
}

function _getSkinKey(localName, prefix, nsMap) {
    if (prefix === 'e') {
        return 'eui.' + localName;
    }

    var nsValue = nsMap[prefix];
    if (nsValue.indexOf('*') < 0) {
        // not supported namespace
        return '';
    }

    return nsValue.replace('*', localName);
}

function _getWidgetName(skinKey) {
    if (!skinKey) {
        return '';
    }

    var dotIdx = skinKey.lastIndexOf('.');
    return skinKey.slice(dotIdx + 1);
}

function _importExml(exmlPath, cb) {
    var exmlName = Path.basename(exmlPath, Path.extname(exmlPath));
    var prefabName = exmlName + '.prefab';
    var relativeFolderPath = Path.relative(SrcResPath, Path.dirname(exmlPath));
    var targetUrl = Url.join(RootUrl, relativeFolderPath);
    var prefabPath = Path.join(TempResPath, relativeFolderPath, prefabName);
    var prefabUrl = Url.join(targetUrl, prefabName);

    if (importedExmls.indexOf(exmlPath) >= 0) {
        return cb(prefabUrl);
    }

    Editor.log('Importing exml file: %s', exmlPath);

    Async.waterfall([
        function(next) {
            _createPrefabFromFile(exmlPath, prefabPath, next);
        },
        function(next) {
            if (!Fs.existsSync(prefabPath)) {
                return next();
            }

            Editor.assetdb.import([prefabPath], targetUrl, false, function () {
                importedExmls.push(exmlPath);
                next();
            });
        }
    ], function() {
        cb(prefabUrl);
    });
}

function _createPrefabFromFile(exmlPath, prefabPath, cb) {
    var doc = new DOMParser().parseFromString(Fs.readFileSync(exmlPath, 'utf-8'));
    if (!doc) {
        Editor.warn('Parse %s failed.', exmlPath);
        cb();
        return;
    }

    var widgetName = _getWidgetName(skinPathToKey[exmlPath]);
    var childNodes = XmlUtils.getAllChildren(doc);
    var rootNodeInfo = childNodes[0];
    var nsMap = rootNodeInfo._nsMap;

    _createNodeGraph(rootNodeInfo, widgetName, nsMap, function(theNode) {
        var prefab = _Scene.PrefabUtils.createPrefabFrom(theNode);
        var prefabData = Editor.serialize(prefab);
        var targetFolder = Path.dirname(prefabPath);
        if (!Fs.existsSync(targetFolder)) {
            Fs.mkdirsSync(targetFolder);
        }
        Fs.writeFileSync(prefabPath, prefabData);
        cb();
    });
}

function _createNodeGraph(nodeInfo, widgetName, nsMap, cb) {
    var localName = nodeInfo.localName;
    var node = null;
    var skinKey = _getSkinKey(localName, nodeInfo.prefix, nsMap);
    Async.waterfall([
        function(next) {
            // create the node from different way
            if (widgetName) {
                // it's a root node of skin file, create a node as the rootNode
                node = new cc.Node(localName);
                next();
            } else {
                if (skinKey && SkinsInfo[skinKey]) {
                    // it's a node using skin, create a node from the skin prefab
                    _importExml(SkinsInfo[skinKey], function(prefabUrl) {
                        // TODO create the node from the skin prefab
                        node = new cc.Node(localName);
                        next();
                    });
                } else {
                    // It's a normal node, create it directly
                    node = new cc.Node(localName);
                    next();
                }
            }
        },
        function(next) {
            // init the base node info
            _initBaseNodeInfo(node, nodeInfo);

            // init the widget info for the node
            if (!widgetName) {
                widgetName = _getWidgetName(skinKey);
            }

            var widgetImporter = WidgetImporters[widgetName];
            if (widgetImporter) {
                widgetImporter(node, nodeInfo);
            }

            next();
        },
        function(next) {
            // create children
            var children = XmlUtils.getAllChildren(nodeInfo);
            var index = 0;
            Async.whilst(function() {
                    return index < children.length;
                },
                function(callback) {
                    var childInfo = children[index];
                    var checker = ChildCheckers[widgetName];
                    if (checker && !checker(childInfo)) {
                        // not a valid child
                        index++;
                        callback();
                    } else {
                        // create child node
                        _createNodeGraph(childInfo, null, nsMap, function(childNode) {
                            node.addChild(childNode);
                            index++;
                            callback();
                        });
                    }
                },
                function() {
                    next();
                }
            );
        }
    ], function() {
        cb(node);
    });
}

function _initBaseNodeInfo(node, nodeInfo) {

}

// importer for widgets
function _importButton() {

}

// methods for checking valid children
function _noChildChecker(childInfo) {
    return false;
}

module.exports = {
    importExmlFiles: importExmlFiles
};
