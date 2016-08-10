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
    'BitmapLabel' : _importBitmapLabel,
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

function _getResUuidByName(resName, isSpFrame) {
    if (!resName) {
        return null;
    }

    var resPath = ResInfo[resName];
    if (!resPath || resPath.length === 0) {
        resPath = resName;
    }

    var resUrl = Url.join(RootUrl, resPath);
    if (isSpFrame) {
        var frameKey = Path.basename(resPath, Path.extname(resPath));
        resUrl = Url.join(resUrl, frameKey);
    }

    var uuid = Editor.assetdb.remote.urlToUuid(resUrl);
    if (Editor.assetdb.remote.existsByUuid(uuid)) {
        return uuid;
    }

    return null;
}

function _getSpriteFrame(uuid) {
    if (!uuid) {
        return null;
    }

    var frame = new cc.SpriteFrame();
    frame._uuid = uuid;
    return frame;
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

function _setScale9Properties(scale9Grid, uuid, cb) {
    if (!scale9Grid) {
        cb();
        return;
    }

    Editor.assetdb.queryMetaInfoByUuid(uuid, function(err,info) {
        if (!info) {
            cb();
            return;
        }

        // modify the meta info
        var meta = JSON.parse(info.json);

        var data = scale9Grid.split(',');
        var dataLeft = parseInt(data[0]);
        var dataTop = parseInt(data[1]);
        var dataWidth = parseInt(data[2]);
        var dataHeight = parseInt(data[3]);

        meta.trimThreshold = -1;
        meta.borderTop = dataTop;
        meta.borderBottom = meta.rawHeight - dataTop - dataHeight;
        if (meta.borderBottom < 0) {
            meta.borderBottom = 0;
        }
        meta.borderLeft = dataLeft;
        meta.borderRight = meta.rawWidth - dataLeft - dataWidth;
        if (meta.borderRight < 0) {
            meta.borderRight = 0;
        }

        var jsonString = JSON.stringify(meta);
        Editor.assetdb.saveMeta( uuid, jsonString );
        cb();
    });
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

    _createNodeGraph(null, rootNodeInfo, widgetName, nsMap, function(theNode) {
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

function _createNodeGraph(parentNode, nodeInfo, widgetName, nsMap, cb) {
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
            if (parentNode) {
                parentNode.addChild(node);
            }

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
                        _createNodeGraph(node, childInfo, null, nsMap, function(childNode) {
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
    node.setPosition(cc.p(x - anchorOffsetX, anchorOffsetY - y));

    // alpha
    var alpha = XmlUtils.getFloatPropertyOfNode(nodeInfo, 'alpha', 1);
    if (alpha > 1) {
        alpha = 1;
    }
    node.setOpacity(alpha * 255);

    // scale
    var scaleX = XmlUtils.getFloatPropertyOfNode(nodeInfo, 'scaleX', 1);
    var scaleY = XmlUtils.getFloatPropertyOfNode(nodeInfo, 'scaleY', 1);
    node.setScaleX(scaleX);
    node.setScaleY(scaleY);

    // visible
    node.active = XmlUtils.getBoolPropertyOfNode(nodeInfo, 'visible', true);
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
    var sourceProp = XmlUtils.getPropertyOfNode(nodeInfo, 'source', '');
    var uuid = _getResUuidByName(sourceProp, true);
    if (uuid) {
        sprite.spriteFrame = _getSpriteFrame(uuid);
    }

    // get the size config
    var width = XmlUtils.getPropertyInOrder(nodeInfo, [ 'width', 'minWidth', 'maxWidth' ], '');
    var height = XmlUtils.getPropertyInOrder(nodeInfo, [ 'height', 'minHeight', 'maxHeight' ], '');
    if (! width && ! height) {
        sprite.sizeMode = cc.Sprite.SizeMode.RAW;
    } else {
        sprite.sizeMode = cc.Sprite.SizeMode.CUSTOM;
    }

    var scale9Grid = XmlUtils.getPropertyOfNode(nodeInfo, 'scale9Grid', '');
    if (scale9Grid) {
        sprite.type = cc.Sprite.Type.SLICED;
        if (uuid) {
            _setScale9Properties(scale9Grid, uuid, cb);
        } else {
            cb();
        }
    } else {
        var fillMode = XmlUtils.getPropertyOfNode(nodeInfo, 'fillMode', 'scale');
        switch(fillMode) {
            case 'repeat':
                sprite.type = cc.Sprite.Type.TILED;
                break;
            case 'clip':
                // TODO sprite in Creator not support this effect
                // treat it as default
            case 'scale':
            default:
                sprite.type = cc.Sprite.Type.SIMPLE;
                break;
        }
        cb();
    }
}

function _importLabel(node, nodeInfo, cb) {
    var label = node.addComponent(cc.Label);
    label.string = XmlUtils.getPropertyOfNode(nodeInfo, 'text', '');
    label.lineHeight = 0;

    // color
    var color = XmlUtils.getPropertyOfNode(nodeInfo, 'textColor', '');
    if (color) {
        color = color.replace('0x', '#');
        node.setColor(cc.hexToColor(color));
    }

    // font size
    label._fontSize = XmlUtils.getIntPropertyOfNode(nodeInfo, 'size', 30);

    // alignment
    var hAlign = XmlUtils.getPropertyOfNode(nodeInfo, 'textAlign', 'left');
    var vAlign = XmlUtils.getPropertyOfNode(nodeInfo, 'verticalAlign', 'top');
    switch(hAlign) {
        case 'left':
        default:
            label.horizontalAlign = cc.Label.HorizontalAlign.LEFT;
            break;
        case 'center':
            label.horizontalAlign = cc.Label.HorizontalAlign.CENTER;
            break;
        case 'right':
            label.horizontalAlign = cc.Label.HorizontalAlign.RIGHT;
            break;
    }

    switch(vAlign) {
        case 'justify':
        case 'top':
        default:
            label.verticalAlign = cc.Label.VerticalAlign.TOP;
            break;
        case 'middle':
            label.verticalAlign = cc.Label.VerticalAlign.CENTER;
            break;
        case 'bottom':
            label.verticalAlign = cc.Label.VerticalAlign.BOTTOM;
            break;
    }

    // overflow mode
    var width = XmlUtils.getPropertyInOrder(nodeInfo, [ 'width', 'minWidth', 'maxWidth' ], '');
    var height = XmlUtils.getPropertyInOrder(nodeInfo, [ 'height', 'minHeight', 'maxHeight' ], '');
    if (! width && ! height) {
        label.overflow = cc.Label.Overflow.NONE;
    } else {
        label.overflow = cc.Label.Overflow.CLAMP;
        label._useOriginalSize = false;
    }

    cb();
}

function _importBitmapLabel(node, nodeInfo, cb) {
    var label = node.addComponent(cc.Label);
    label.string = XmlUtils.getPropertyOfNode(nodeInfo, 'text', '');
    label.lineHeight = 0;

    // overflow mode
    var width = XmlUtils.getPropertyInOrder(nodeInfo, [ 'width', 'minWidth', 'maxWidth' ], '');
    var height = XmlUtils.getPropertyInOrder(nodeInfo, [ 'height', 'minHeight', 'maxHeight' ], '');
    if (! width && ! height) {
        label.overflow = cc.Label.Overflow.NONE;
    } else {
        label.overflow = cc.Label.Overflow.CLAMP;
        label._useOriginalSize = false;
    }

    var fntUuid = _getResUuidByName(XmlUtils.getPropertyOfNode(nodeInfo, 'font', ''));
    if (fntUuid) {
        Async.waterfall([
            next => {
                cc.AssetLibrary.loadAsset(fntUuid, function(err, res) {
                    if (err) {
                        return next();
                    }
                    label.font = res;
                    next();
                });
            },
            next => {
                var fntFile = Editor.assetdb.remote.uuidToFspath(fntUuid);
                cc.loader.load(fntFile, function(err, config) {
                    if (err) {
                        return next();
                    }

                    label._fontSize = config.fontSize;
                    label.lineHeight = config.commonHeight;
                    next();
                });
            }
        ], cb);
    } else {
        cb();
    }
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
