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
    'Button' : _importButton,
    'HScrollBar' : _importHScrollBar,
    'VScrollBar' : _importVScrollBar,
    'Scroller' : _importScroller,
    'ProgressBar' : _importProgressBar,
    'Rect': _importRect,
    'EditableText': _importLabel,
    'TextInput': _importTextInput,
};

const ChildCheckers = {
    'Button' : _noChildChecker,
    'Label' : _noChildChecker,
    'Image' : _noChildChecker
};

const DEFAULT_SPLASH_SP_URL = 'db://internal/image/default_sprite_splash.png/default_sprite_splash';

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
    var usingSkin = false;
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
                                usingSkin = true;
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
            _initBaseNodeInfo(node, nodeInfo, usingSkin);

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

function _addWidget(node, nodeInfo, widthPercent, heightPercent) {
    var left = XmlUtils.getFloatPropertyOfNode(nodeInfo, 'left', null);
    var right = XmlUtils.getFloatPropertyOfNode(nodeInfo, 'right', null);
    var top = XmlUtils.getFloatPropertyOfNode(nodeInfo, 'top', null);
    var bottom = XmlUtils.getFloatPropertyOfNode(nodeInfo, 'bottom', null);
    var horizontalCenter = XmlUtils.getFloatPropertyOfNode(nodeInfo, 'horizontalCenter', null);
    var verticalCenter = XmlUtils.getFloatPropertyOfNode(nodeInfo, 'verticalCenter', null);

    if (left === null && right === null && top === null && bottom === null &&
        horizontalCenter === null && verticalCenter === null &&
        widthPercent < 0 && heightPercent < 0) {
        // don't need add widget component
        return;
    }

    var widget = _tryAddComponent(node, cc.Widget);
    if (!widget) {
        return;
    }

    var parent = node.getParent();
    var parentSize = cc.size(0, 0);
    if (parent) {
        parentSize = parent.getContentSize();
    }
    if (widthPercent > 0 && parent) {
        widget.isAlignLeft = true;
        widget.isAlignRight = true;
        if (left !== null && right === null) {
            widget.left = left;
            widget.right = parentSize.width * (1 - widthPercent) - left;
        }
        else if (right !== null && left === null) {
            widget.left = parentSize.width * (1 - widthPercent) - right;
            widget.right = right;
        }
        else if (right === null && left === null) {
            widget.left = parentSize.width * (1 - widthPercent) / 2;
            widget.right = widget.left;
        } else {
            widget.left = left;
            widget.right = right;
        }
    }
    else if (horizontalCenter === 0) {
        widget.isAlignHorizontalCenter = true;
    } else {
        if (left !== null) {
            widget.isAlignLeft = true;
            widget.left = left;
        }

        if (right !== null) {
            widget.isAlignRight = true;
            widget.right = right;
        }
    }

    if (heightPercent > 0 && parent) {
        widget.isAlignTop = true;
        widget.isAlignBottom = true;
        if (top !== null && bottom === null) {
            widget.top = top;
            widget.bottom = parentSize.height * (1 - heightPercent) - top;
        }
        else if (bottom !== null && top === null) {
            widget.top = parentSize.height * (1 - heightPercent) - bottom;
            widget.bottom = bottom;
        }
        else if (bottom === null && top === null) {
            widget.bottom = parentSize.height * (1 - heightPercent) / 2;
            widget.top = widget.bottom;
        } else {
            widget.top = top;
            widget.bottom = bottom;
        }
    }
    else if (verticalCenter === 0) {
        widget.isAlignVerticalCenter = true;
    } else {
        if (top !== null) {
            widget.isAlignTop = true;
            widget.top = top;
        }

        if (bottom !== null) {
            widget.isAlignBottom = true;
            widget.bottom = bottom;
        }
    }
}

function _initBaseNodeInfo(node, nodeInfo, usingSkin) {
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
    else if (usingSkin) {
        nodeSize.width = node.getContentSize().width;
    }

    if (height) {
        if (heightPercent >= 0) {
            nodeSize.height = parentSize.height * heightPercent;
        } else {
            nodeSize.height = parseFloat(height);
        }
    }
    else if (usingSkin) {
        nodeSize.height = node.getContentSize().height;
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

    // rotation
    node.setRotation(XmlUtils.getFloatPropertyOfNode(nodeInfo, 'rotation', 0));

    // visible
    node.active = XmlUtils.getBoolPropertyOfNode(nodeInfo, 'visible', true);

    // add widget component if necessary
    _addWidget(node, nodeInfo, widthPercent, heightPercent);
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

function _importRect(node, nodeInfo, cb) {
    var sprite = _tryAddComponent(node, cc.Sprite);
    if (!sprite) {
        return;
    }

    sprite.sizeMode = cc.Sprite.SizeMode.CUSTOM;
    sprite.trim = false;
    sprite.spriteFrame = new cc.SpriteFrame();
    sprite.spriteFrame._uuid = Editor.assetdb.remote.urlToUuid(DEFAULT_SPLASH_SP_URL);

    // color related
    var fillAlpha = XmlUtils.getFloatPropertyOfNode(nodeInfo, 'fillAlpha', 1);
    if (fillAlpha > 1) fillAlpha = 1;
    node.setOpacity(255 * fillAlpha);
    var fillColor = XmlUtils.getPropertyOfNode(nodeInfo, 'fillColor', '0x000000');
    node.setColor(cc.hexToColor(fillColor.replace('0x', '#')));

    cb();
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

function _tryAddComponent(node, component) {
    var comObj = node.getComponent(component);
    if (!comObj) {
        comObj = node.addComponent(component);
    }

    return comObj;
}

function _importButton(node, nodeInfo, cb) {
    cb();
}

function _initScrollBar(node, nodeInfo, direction) {
    var scrollbar = _tryAddComponent(node, cc.Scrollbar);
    if (!scrollbar) {
        return;
    }

    scrollbar.direction = direction;
    scrollbar.enableAutoHide = XmlUtils.getBoolPropertyOfNode(nodeInfo, 'autoVisibility', true);
    var thumbNode = node.getChildByName('thumb');
    if (thumbNode) {
        var barSp = thumbNode.getComponent(cc.Sprite);
        if (barSp) {
            barSp.type = cc.Sprite.Type.SLICED;
            barSp.trim = false;
            barSp.sizeMode = cc.Sprite.SizeMode.CUSTOM;
            scrollbar.handle = barSp;
        }
    }
}

function _importHScrollBar(node, nodeInfo, cb) {
    _initScrollBar(node, nodeInfo, cc.Scrollbar.Direction.HORIZONTAL);
    cb();
}

function _importVScrollBar(node, nodeInfo, cb) {
    _initScrollBar(node, nodeInfo, cc.Scrollbar.Direction.VERTICAL);
    cb();
}

function _importScroller(node, nodeInfo, cb) {
    var scroll = _tryAddComponent(node, cc.ScrollView);
    if (!scroll) {
        return cb();
    }

    // add a mask component
    _tryAddComponent(node, cc.Mask);

    // set property of scroll view
    var scrollPolicyH = XmlUtils.getPropertyOfNode(nodeInfo, 'scrollPolicyH', 'auto');
    var scrollPolicyV = XmlUtils.getPropertyOfNode(nodeInfo, 'scrollPolicyV', 'auto');
    scroll.horizontal = (scrollPolicyH !== 'off');
    scroll.vertical = (scrollPolicyV !== 'off');

    var hBarNode = node.getChildByName('horizontalScrollBar');
    var vBarNode = node.getChildByName('verticalScrollBar');
    if (hBarNode) {
        var hBarCom = hBarNode.getComponent(cc.Scrollbar);
        if (hBarCom) {
            scroll.horizontalScrollBar = hBarCom;
        }
    }

    if (vBarNode) {
        var vBarCom = vBarNode.getComponent(cc.Scrollbar);
        if (vBarCom) {
            scroll.verticalScrollBar = vBarCom;
        }
    }

    var throwSpeed = XmlUtils.getFloatPropertyOfNode(nodeInfo, 'throwSpeed', 0);
    scroll.inertia = (throwSpeed > 0);

    // set content of scroll view
    var containerTypes = [ 'Group', 'DataGroup', 'List', 'ListBase', 'TabBar', 'ViewStack' ];
    var viewport = node.getChildByName('viewport');
    if (!viewport) {
        for (var idx in containerTypes) {
            var containerName = containerTypes[idx];
            var childNode = node.getChildByName(containerName);
            if (childNode) {
                viewport = childNode;
                break;
            }
        }
    }

    if (!viewport) {
        return cb();
    }
    var viewSize = viewport.getContentSize();
    if (viewSize.equals(cc.Size.ZERO)) {
        viewport.setContentSize(node.getContentSize());
    }
    scroll.content = viewport;
    cb();
}

function _importProgressBar(node, nodeInfo, cb) {
    var progressbar = _tryAddComponent(node, cc.ProgressBar);
    if (!progressbar) {
        return cb();
    }

    var dir = XmlUtils.getPropertyOfNode(nodeInfo, 'direction', 'ltr');
    progressbar.mode = cc.ProgressBar.Mode.FILLED;
    progressbar.reverse = (dir === 'rtl' || dir === 'ttb');

    var thumbNode = node.getChildByName('thumb');
    if (thumbNode) {
        var barSp = thumbNode.getComponent(cc.Sprite);
        if (barSp) {
            barSp.type = cc.Sprite.Type.FILLED;
            barSp.trim = false;
            barSp.sizeMode = cc.Sprite.SizeMode.CUSTOM;
            if (dir === 'ltr' || dir === 'rtl') {
                barSp.fillType = cc.Sprite.FillType.HORIZONTAL;
            } else {
                barSp.fillType = cc.Sprite.FillType.VERTICAL;
            }
            barSp.fillStart = progressbar.reverse ? 1 : 0;
            barSp.fillRange = 1;
            var nodeSize = node.getContentSize();
            progressbar.barSprite = barSp;
            node.setContentSize(nodeSize);
        }
    }

    // values
    var maxValue = XmlUtils.getFloatPropertyOfNode(nodeInfo, 'maximum', 100);
    var value = XmlUtils.getFloatPropertyOfNode(nodeInfo, 'value', 0);
    value = Math.round(value);
    progressbar.totalLength = 1;
    progressbar.progress = value / maxValue;

    var labelNode = node.getChildByName('labelDisplay');
    if (labelNode) {
        var label = labelNode.getComponent(cc.Label);
        if (label) {
            label.string = `${value} / ${maxValue}`;
        }
    }

    cb();
}

function _importTextInput(node, nodeInfo, cb) {
    var edit = node.getComponent(cc.EditBox);
    var isSkin = false;
    if (!edit) {
        edit = node.addComponent(cc.EditBox);
        isSkin = true;
    }

    if (!edit) {
        return cb();
    }

    // get some properties from children
    var promptColor = null;
    var promptSize = -1;
    var promptNode = node.getChildByName('promptDisplay');
    if (promptNode) {
        var promptLabel = promptNode.getComponent(cc.Label);
        if (promptLabel) {
            promptColor = promptNode.getColor();
            promptSize = promptLabel.fontSize;
        }
    }

    var defaultTextColor = cc.color(255, 255, 255);
    var textSize = -1;
    var textNode = node.getChildByName('textDisplay');
    if (textNode) {
        var textLabel = textNode.getComponent(cc.Label);
        if (textLabel) {
            textSize = textLabel.fontSize;
            defaultTextColor = textNode.getColor();
        }
    }

    var backSpFrame = null;
    var backImgNode = node.getChildByName('Image');
    if (backImgNode) {
        var backSprite = backImgNode.getComponent(cc.Sprite);
        if (backSprite) {
            backSpFrame = backSprite.spriteFrame;
        }
    }

    if (isSkin) {
        // if it's the skin of TextInput, should not remove children
        // only set the children active to false
        var children = node._children;
        for (var idx in children) {
            children[idx].active = false;
        }
    } else {
        // remove all children
        node.removeAllChildren();
    }

    // set the property of edit box
    edit._useOriginalSize = false;
    edit.string = XmlUtils.getPropertyOfNode(nodeInfo, 'text', '');
    if (backSpFrame) edit.backgroundImage = backSpFrame;
    var displayAsPassword = XmlUtils.getBoolPropertyOfNode(nodeInfo, 'displayAsPassword', false);
    edit.inputFlag = displayAsPassword ? cc.EditBox.InputFlag.PASSWORD : cc.EditBox.InputFlag.SENSITIVE;
    var maxLength = XmlUtils.getIntPropertyOfNode(nodeInfo, 'maxChars', 0);
    if (textSize > 0) edit.fontSize = textSize;
    edit.lineHeight = edit.fontSize;
    var textColor = XmlUtils.getPropertyOfNode(nodeInfo, 'textColor', '');
    if (textColor) {
        edit.fontColor = cc.hexToColor(textColor.replace('0x', '#'));
    } else {
        edit.fontColor = defaultTextColor;
    }
    if (promptColor) edit.placeholderFontColor = promptColor;
    if (promptSize > 0) edit.placehoderFontSize = promptSize;
    edit.placeholder = XmlUtils.getPropertyOfNode(nodeInfo, 'prompt', '');
    edit.maxLength = maxLength === 0 ? -1 : maxLength;

    cb();
}

// methods for checking valid children
function _noChildChecker(childInfo) {
    return false;
}

module.exports = {
    importExmlFiles: importExmlFiles
};
