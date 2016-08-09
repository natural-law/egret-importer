'use strict';

const Async = require('async');
const Path = require('path');
const Fs = require('fire-fs');
const Url = require('fire-url');
const DOMParser = require('xmldom').DOMParser;
const XmlUtils = require('./xml-utils');

const WidgetImporters = {
    'Image': _importImage,
    'Label' : _importLabel,
    'BitmapLabel' : _importLabel,
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
        resPath = resName;
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
    var skinNameNode = XmlUtils.getFirstChildNodeByLocalName(nodeInfo, 'skinName');
    var widgetKey = widgetName;
    var nodeName = _getNodeName(nodeInfo, widgetName);
    Async.waterfall([
        function(next) {
            // create the node from different way
            if (widgetName) {
                // it's a root node of skin file, create a node as the rootNode
                node = new cc.Node(nodeName);
                next();
            } else {
                if (skinNameNode) {
                    node = new cc.Node(nodeName);
                    next();
                }
                else if (skinKey && SkinsInfo[skinKey]) {
                    // it's a node using skin, create a node from the skin prefab
                    _importExml(SkinsInfo[skinKey], function(prefabUrl) {
                        // create the node from the skin prefab
                        var uuid = Editor.assetdb.remote.urlToUuid(prefabUrl);
                        cc.AssetLibrary.loadAsset(uuid, function (err, prefab) {
                            if (err) {
                                node = new cc.Node(nodeName);
                                next();
                            } else {
                                node = cc.instantiate(prefab);
                                node.setName(nodeName);
                                next();
                            }
                        });
                    });
                } else {
                    // It's a normal node, create it directly
                    node = new cc.Node(nodeName);
                    next();
                }
            }
        },
        function(next) {
            // init the base node info
            _initBaseNodeInfo(node, nodeInfo);

            // create children
            var children = null;
            if (skinNameNode) {
                var skinNode = XmlUtils.getFirstChildNodeByLocalName(skinNameNode, 'Skin');
                children = XmlUtils.getAllChildren(skinNode);
            } else {
                children = XmlUtils.getAllChildren(nodeInfo);
            }
            var index = 0;
            Async.whilst(function() {
                    return index < children.length;
                },
                function(callback) {
                    var childInfo = children[index];
                    var checker = ChildCheckers[widgetKey];
                    if (!widgetName && checker && !checker(childInfo)) {
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
                next
            );
        },
        function(next) {
            // init the widget info for the node
            if (!widgetKey) {
                widgetKey = _getWidgetName(skinKey);
            }

            var widgetImporter = WidgetImporters[widgetKey];
            if (widgetImporter) {
                widgetImporter(node, nodeInfo, next);
            } else {
                next();
            }
        }
    ], function() {
        cb(node);
    });
}

function _getPercentValue(theValue) {
    if (theValue.indexOf('%') >= 0) {
        var percent = parseFloat(theValue);
        return percent / 100;
    }

    return -1;
}

function _initBaseNodeInfo(node, nodeInfo) {
    // get the parent
    var parent = node.getParent();
    var parentSize = cc.size(0, 0);
    if (parent) {
        parentSize = parent.getContentSize();
    }

    // init the width & height
    var width = XmlUtils.getPropertyInOrder(nodeInfo, [ 'width', 'minWidth', 'maxWidth' ], '');
    var height = XmlUtils.getPropertyInOrder(nodeInfo, [ 'height', 'minHeight', 'maxHeight' ], '');
    var widthPercent = _getPercentValue(width);
    var heightPercent = _getPercentValue(height);

    var nodeSize = cc.size(0, 0);
    if (width) {
        if (widthPercent >= 0) {
            nodeSize.width = parentSize.width * widthPercent;
        } else {
            nodeSize.width = parseFloat(width);
        }
    }

    if (height) {
        if (heightPercent >= 0) {
            nodeSize.height = parentSize.height * heightPercent;
        } else {
            nodeSize.height = parseFloat(height);
        }
    }
    node.setContentSize(nodeSize);

    // init the anchor point
    node.setAnchorPoint(cc.p(0, 1));

    // init the position
    var x = XmlUtils.getFloatPropertyOfNode(nodeInfo, 'x', 0);
    var y = XmlUtils.getFloatPropertyOfNode(nodeInfo, 'y', 0);
    var anchorOffsetX = XmlUtils.getFloatPropertyOfNode(nodeInfo, 'anchorOffsetX', 0);
    var anchorOffsetY = XmlUtils.getFloatPropertyOfNode(nodeInfo, 'anchorOffsetY', 0);
    node.setPosition(cc.p(x - anchorOffsetX, parentSize.height - y + anchorOffsetY));
}

function _getNodeName(nodeInfo, widgetName) {
    var id = XmlUtils.getPropertyOfNode(nodeInfo, 'id', '');
    if (id)
        return id;

    var name = XmlUtils.getPropertyOfNode(nodeInfo, 'name', '');
    if (name)
        return name;

    if (widgetName)
        return widgetName;

    return nodeInfo.localName;
}

// importer for widgets
function _importImage(node, nodeInfo, cb) {
    var sprite = node.addComponent(cc.Sprite);
    cb();
}

function _importLabel(node, nodeInfo, cb) {
    cb();
}

function _importButton(node, nodeInfo, cb) {
    cb();
}

// methods for checking valid children
function _noChildChecker(childInfo) {
    return false;
}

module.exports = {
    importExmlFiles: importExmlFiles
};
