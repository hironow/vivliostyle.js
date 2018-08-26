/**
 * Copyright 2013 Google, Inc.
 * Copyright 2015 Trim-marks Inc.
 *
 * Vivliostyle.js is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Vivliostyle.js is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Vivliostyle.js.  If not, see <http://www.gnu.org/licenses/>.
 *
 * @fileoverview Apply CSS cascade to a document incrementally and cache the
 * result.
 */
import * as asserts from '../closure/goog/asserts/asserts';

import * as breaks from '../vivliostyle/break';
import {isBlock} from '../vivliostyle/display';

import * as base from './base';
import {Val, Ident, ident} from './css';
import * as csscasc from './csscasc';
import * as cssprop from './cssprop';
import {ValidatorSet, ValueMap} from './cssvalid';
import * as cssparse from './cssparse';
import {Context, defaultUnitSizes, LexicalScope} from './expr';
import * as expr from './expr';
import * as vtree from './vtree';
import * as xmldoc from './xmldoc';

export class SlipRange {
  endStuckFixed: number;
  endFixed: number;
  endSlipped: number;

  constructor(endStuckFixed, endFixed, endSlipped) {
    this.endStuckFixed = endStuckFixed;
    this.endFixed = endFixed;
    this.endSlipped = endSlipped;
  }
}

/**
 * Maps all ints in a range ("fixed") to ints with slippage ("slipped")
 */
export class SlipMap {
  map: any = ([] as SlipRange[]);

  getMaxFixed(): number {
    if (this.map.length == 0) {
      return 0;
    }
    const range = this.map[this.map.length - 1];
    return range.endFixed;
  }

  getMaxSlipped(): number {
    if (this.map.length == 0) {
      return 0;
    }
    const range = this.map[this.map.length - 1];
    return range.endSlipped;
  }

  addStuckRange(endFixed: number): void {
    if (this.map.length == 0) {
      this.map.push(new SlipRange(endFixed, endFixed, endFixed));
    } else {
      const range = this.map[this.map.length - 1];
      const endSlipped = range.endSlipped + endFixed - range.endFixed;
      if (range.endFixed == range.endStuckFixed) {
        range.endFixed = endFixed;
        range.endStuckFixed = endFixed;
        range.endSlipped = endSlipped;
      } else {
        this.map.push(new SlipRange(endFixed, endFixed, endSlipped));
      }
    }
  }

  addSlippedRange(endFixed: number): void {
    if (this.map.length == 0) {
      this.map.push(new SlipRange(endFixed, 0, 0));
    } else {
      this.map[this.map.length - 1].endFixed = endFixed;
    }
  }

  slippedByFixed(fixed: number): number {
    const self = this;
    const index = base.binarySearch(
        this.map.length, (index) => fixed <= self.map[index].endFixed);
    const range = this.map[index];
    return range.endSlipped - Math.max(0, range.endStuckFixed - fixed);
  }

  /**
   * Smallest fixed for a given slipped.
   */
  fixedBySlipped(slipped: number): number {
    const self = this;
    const index = base.binarySearch(
        this.map.length, (index) => slipped <= self.map[index].endSlipped);
    const range = this.map[index];
    return range.endStuckFixed - (range.endSlipped - slipped);
  }
}

export interface FlowListener {
  /**
   * @return void
   */
  encounteredFlowChunk(flowChunk: vtree.FlowChunk, flow: vtree.Flow): any;
}

export interface AbstractStyler {
  getStyle(element: Element, deep: boolean): csscasc.ElementStyle;

  processContent(element: Element, styles: {[key: string]: Val});
}

/**
 * Represent a box generated by a (pseudo)element. When constructed, a box
 * corresponding to `::before` pseudoelement is also constructed and stored in
 * `beforeBox` property, whereas one corresponding `::after` pseudoelement is
 * not constructed and `afterBox` property is `null`. `afterBox` is constructed
 * by `buildAfterPseudoElementBox` method.
 * @param style Cascaded style values for the box.
 * @param offset The start offset of the box. It coincides with the start offset
 *     of the element if the box is generated by the element or the `::before`
 *     pseudoelement. When the box corresponds to the `::after` pseudoelement,
 *     the offset is just after the content before the `::after` pseudoelement.
 * @param isRoot True if the box is generated by the root element (not
 *     pseudoelement).
 * @param flowChunk FlowChunk to which the box belongs to.
 * @param atBlockStart True if the box is right after the block start edge.
 * @param atFlowStart True if the box is right after the flow start.
 * @param isParentBoxDisplayed True if the parent box has a displayed box.
 */
export class Box {
  flowName: any;
  isBlockValue: boolean|null = null;
  hasBoxValue: boolean|null = null;
  styleValues: any = ({} as {[key: string]: Val});
  beforeBox: Box = null;
  afterBox: Box = null;
  breakBefore: string|null = null;

  constructor(
      public readonly context: Context,
      public readonly style: csscasc.ElementStyle,
      public readonly offset: number, public readonly isRoot: boolean,
      public readonly flowChunk: vtree.FlowChunk,
      public readonly atBlockStart: boolean,
      public readonly atFlowStart: boolean,
      public readonly isParentBoxDisplayed: boolean) {
    this.flowName = flowChunk.flowName;
    if (this.hasBox()) {
      const pseudoMap = style['_pseudos'];
      if (pseudoMap) {
        if (pseudoMap['before']) {
          const beforeBox = new Box(
              context, pseudoMap['before'], offset, false, flowChunk,
              this.isBlock(), atFlowStart, true);
          const beforeContent = beforeBox.styleValue('content');
          if (vtree.nonTrivialContent(beforeContent)) {
            this.beforeBox = beforeBox;
            this.breakBefore = beforeBox.breakBefore;
          }
        }
      }
    }
    this.breakBefore = breaks.resolveEffectiveBreakValue(
        this.getBreakValue('before'), this.breakBefore);
    if (this.atFlowStart &&
        breaks.isForcedBreakValue(this.breakBefore)) {
      flowChunk.breakBefore = breaks.resolveEffectiveBreakValue(
          flowChunk.breakBefore, this.breakBefore);
    }
  }

  /**
   * Build a box corresponding to `::after` pseudoelement and stores it in
   * `afterBox` property.
   * @param offset The start offset of the `::after` pseudoelement box, which is
   *     just after the content before the `::after` pseudoelement.
   * @param atBlockStart True if the box is right after the block start edge.
   * @param atFlowStart True if the box is right after the flow start.
   */
  buildAfterPseudoElementBox(
      offset: number, atBlockStart: boolean, atFlowStart: boolean) {
    if (this.hasBox()) {
      const pseudoMap = this.style['_pseudos'];
      if (pseudoMap) {
        if (pseudoMap['after']) {
          const afterBox = new Box(
              this.context, pseudoMap['after'], offset, false, this.flowChunk,
              atBlockStart, atFlowStart, true);
          const afterContent = afterBox.styleValue('content');
          if (vtree.nonTrivialContent(afterContent)) {
            this.afterBox = afterBox;
          }
        }
      }
    }
  }

  styleValue(name: string, defaultValue?: Val): Val|null {
    if (!(name in this.styleValues)) {
      const cv = this.style[name];
      this.styleValues[name] =
          cv ? cv.evaluate(this.context, name) : defaultValue || null;
    }
    return this.styleValues[name];
  }

  displayValue(): Val {
    return this.styleValue('display', ident.inline);
  }

  isBlock(): boolean {
    if (this.isBlockValue === null) {
      const display = (this.displayValue() as Ident);
      const position = (this.styleValue('position') as Ident);
      const float = (this.styleValue('float') as Ident);
      this.isBlockValue =
          isBlock(display, position, float, this.isRoot);
    }
    return this.isBlockValue;
  }

  hasBox(): boolean {
    if (this.hasBoxValue === null) {
      this.hasBoxValue = this.isParentBoxDisplayed &&
          this.displayValue() !== ident.none;
    }
    return this.hasBoxValue;
  }

  getBreakValue(edge: string): string|null {
    let breakValue = null;
    if (this.isBlock()) {
      const val = this.styleValue(`break-${edge}`);
      if (val) {
        breakValue = val.toString();
      }
    }
    return breakValue;
  }
}

/**
 * Manages boxes generated by elements as a stack.
 */
export class BoxStack {
  stack: any = ([] as Box[]);
  atBlockStart: boolean = true;

  // indicates if the next pushed box will be at the block start
  atFlowStart: boolean = true;

  // indicates if the next pushed box will be at the flow start
  atStartStack: any = ([] as {atBlockStart: boolean, atFlowStart: boolean}[]);

  constructor(public readonly context: Context) {}

  /**
   * Returns if the stack is empty.
   */
  empty(): boolean {
    return this.stack.length === 0;
  }

  /**
   * Returns the last box in the stack.
   */
  lastBox(): Box|undefined {
    return this.stack[this.stack.length - 1];
  }

  /**
   * Returns the flow name of the last box in the stack.
   */
  lastFlowName(): string|null {
    const lastBox = this.lastBox();
    return lastBox ? lastBox.flowChunk.flowName : null;
  }

  /**
   * Returns if the last box in the stack is displayed.
   */
  isCurrentBoxDisplayed(): boolean {
    return this.stack.every(
        (box) => box.displayValue() !== ident.none);
  }

  /**
   * Create a new box and push it to the stack.
   * @param style Cascaded style values for the box.
   * @param offset The start offset of the box.
   * @param isRoot True if the box is generated by the root element
   * @param newFlowChunk Specify if the element is a flow element (i.e. the
   *     element is specified a new `flow-into` value)
   */
  push(
      style: csscasc.ElementStyle, offset: number, isRoot: boolean,
      newFlowChunk?: vtree.FlowChunk): Box {
    const lastBox = this.lastBox();
    if (newFlowChunk && lastBox && newFlowChunk.flowName !== lastBox.flowName) {
      this.atStartStack.push(
          {atBlockStart: this.atBlockStart, atFlowStart: this.atFlowStart});
    }
    const flowChunk = newFlowChunk || lastBox.flowChunk;
    const isAtFlowStart = this.atFlowStart || !!newFlowChunk;
    const isParentBoxDisplayed = this.isCurrentBoxDisplayed();
    const box = new Box(
        this.context, style, offset, isRoot, flowChunk,
        isAtFlowStart || this.atBlockStart, isAtFlowStart,
        isParentBoxDisplayed);
    this.stack.push(box);
    this.atBlockStart =
        box.hasBox() ? !box.beforeBox && box.isBlock() : this.atBlockStart;
    this.atFlowStart =
        box.hasBox() ? !box.beforeBox && isAtFlowStart : this.atFlowStart;
    return box;
  }

  encounteredTextNode(node: Node) {
    const box = this.lastBox();
    if ((this.atBlockStart || this.atFlowStart) && box.hasBox()) {
      const whitespaceValue =
          box.styleValue('white-space', ident.normal).toString();
      const whitespace = vtree.whitespaceFromPropertyValue(whitespaceValue);
      asserts.assert(whitespace !== null);
      if (!vtree.canIgnore(node, whitespace)) {
        this.atBlockStart = false;
        this.atFlowStart = false;
      }
    }
  }

  /**
   * Pop the last box.
   */
  pop(offset: number): Box {
    const box = this.stack.pop();
    box.buildAfterPseudoElementBox(offset, this.atBlockStart, this.atFlowStart);
    if (this.atFlowStart && box.afterBox) {
      const breakBefore = box.afterBox.getBreakValue('before');
      box.flowChunk.breakBefore = breaks.resolveEffectiveBreakValue(
          box.flowChunk.breakBefore, breakBefore);
    }
    const parent = this.lastBox();
    if (parent) {
      if (parent.flowName === box.flowName) {
        if (box.hasBox()) {
          this.atBlockStart = this.atFlowStart = false;
        }
      } else {
        const atStart = this.atStartStack.pop();
        this.atBlockStart = atStart.atBlockStart;
        this.atFlowStart = atStart.atFlowStart;
      }
    }
    return box;
  }

  /**
   * Find the start offset of the nearest block start edge to which the
   * `break-before` value of the box should be propagated. This method can be
   * called when after pushing the box into the stack or after popping the box
   * out of the stack.
   */
  nearestBlockStartOffset(box: Box): number {
    if (!box.atBlockStart) {
      return box.offset;
    }
    let i = this.stack.length - 1;
    let parent = this.stack[i];

    // When called just after the box is popped out, the last box in the stack
    // is different from the box and it is the parent of the box. When called
    // after the box is pushed, the last box in the stack is identical to the
    // box and the parent of the box is a box right before the specified box.
    if (parent === box) {
      i--;
      parent = this.stack[i];
    }
    while (i >= 0) {
      if (parent.flowName !== box.flowName) {
        return box.offset;
      }
      if (!parent.atBlockStart) {
        return parent.offset;
      }
      if (parent.isRoot) {
        return parent.offset;
      }
      box = parent;
      parent = this.stack[--i];
    }
    throw new Error('No block start offset found!');
  }
}

// pushed when a new flow starts
export class Styler implements AbstractStyler {
  root: any;
  cascadeHolder: any;
  last: Node;
  rootStyle: any = ({} as csscasc.ElementStyle);
  styleMap: {[key: string]: csscasc.ElementStyle} = {};
  flows: any = ({} as {[key: string]: vtree.Flow});
  flowChunks: any = ([] as vtree.FlowChunk[]);
  flowListener: FlowListener = null;
  flowToReach: string|null = null;
  idToReach: string|null = null;
  cascade: any;
  offsetMap: any;
  primary: boolean = true;
  primaryStack: any = ([] as boolean[]);
  rootBackgroundAssigned: boolean = false;
  rootLayoutAssigned: boolean = false;
  lastOffset: number;
  breakBeforeValues: any = ({} as {[key: number]: string | null});
  boxStack: any;
  bodyReached: boolean = true;

  constructor(
      public readonly xmldoc: xmldoc.XMLDocHolder, cascade: csscasc.Cascade,
      public readonly scope: LexicalScope, public readonly context: Context,
      public readonly primaryFlows: {[key: string]: boolean},
      public readonly validatorSet: ValidatorSet,
      public readonly counterListener: csscasc.CounterListener,
      counterResolver: csscasc.CounterResolver) {
    this.root = xmldoc.root;
    this.cascadeHolder = cascade;
    this.last = this.root;
    this.cascade = cascade.createInstance(
        context, counterListener, counterResolver, xmldoc.lang);
    this.offsetMap = new SlipMap();
    const rootOffset = xmldoc.getElementOffset(this.root);
    this.lastOffset = rootOffset;
    this.boxStack = new BoxStack(context);
    this.offsetMap.addStuckRange(rootOffset);
    const style = this.getAttrStyle(this.root);
    this.cascade.pushElement(this.root, style, rootOffset);
    this.postprocessTopStyle(style, false);
    switch (this.root.namespaceURI) {
      case base.NS.XHTML:
      case base.NS.FB2:
        this.bodyReached = false;
        break;
    }
    this.primaryStack.push(true);
    this.styleMap = {};
    this.styleMap[`e${rootOffset}`] = style;
    this.lastOffset++;
    this.replayFlowElementsFromOffset(-1);
  }

  hasProp(style: csscasc.ElementStyle, map: ValueMap, name: string): boolean {
    const cascVal = style[name];
    return cascVal && cascVal.evaluate(this.context) !== map[name];
  }

  transferPropsToRoot(srcStyle: csscasc.ElementStyle, map: ValueMap): void {
    for (const pname in map) {
      const cascval = srcStyle[pname];
      if (cascval) {
        this.rootStyle[pname] = cascval;
        delete srcStyle[pname];
      } else {
        const val = map[pname];
        if (val) {
          this.rootStyle[pname] =
              new csscasc.CascadeValue(val, cssparse.SPECIFICITY_AUTHOR);
        }
      }
    }
  }

  /**
   * Transfer properties that should be applied on the container (partition)
   * level to this.rootStyle.
   * @param elemStyle (source) element style
   */
  postprocessTopStyle(elemStyle: csscasc.ElementStyle, isBody: boolean): void {
    if (!isBody) {
      ['writing-mode', 'direction'].forEach(function(propName) {
        if (elemStyle[propName]) {
          // Copy it over, but keep it at the root element as well.
          this.rootStyle[propName] = elemStyle[propName];
        }
      }, this);
    }
    if (!this.rootBackgroundAssigned) {
      const backgroundColor =
          (this.hasProp(
               elemStyle, this.validatorSet.backgroundProps,
               'background-color') ?
               elemStyle['background-color'].evaluate(this.context) :
               null as Val);
      const backgroundImage =
          (this.hasProp(
               elemStyle, this.validatorSet.backgroundProps,
               'background-image') ?
               elemStyle['background-image'].evaluate(this.context) :
               null as Val);
      if (backgroundColor && backgroundColor !== ident.inherit ||
          backgroundImage && backgroundImage !== ident.inherit) {
        this.transferPropsToRoot(elemStyle, this.validatorSet.backgroundProps);
        this.rootBackgroundAssigned = true;
      }
    }
    if (!this.rootLayoutAssigned) {
      for (let i = 0; i < columnProps.length; i++) {
        if (this.hasProp(
                elemStyle, this.validatorSet.layoutProps, columnProps[i])) {
          this.transferPropsToRoot(elemStyle, this.validatorSet.layoutProps);
          this.rootLayoutAssigned = true;
          break;
        }
      }
    }
    if (!isBody) {
      const fontSize = elemStyle['font-size'];
      if (fontSize) {
        const val = fontSize.evaluate(this.context);
        let px = val.num;
        switch (val.unit) {
          case 'em':
          case 'rem':
            px *= this.context.initialFontSize;
            break;
          case 'ex':
            px *= this.context.initialFontSize *
                expr.defaultUnitSizes['ex'] /
                expr.defaultUnitSizes['em'];
            break;
          case '%':
            px *= this.context.initialFontSize / 100;
            break;
          default:
            const unitSize = expr.defaultUnitSizes[val.unit];
            if (unitSize) {
              px *= unitSize;
            }
        }
        this.context.rootFontSize = px;
      }
    }
  }

  getTopContainerStyle(): csscasc.ElementStyle {
    let offset = 0;
    while (!this.bodyReached) {
      offset += 5000;
      if (this.styleUntil(offset, 0) == Number.POSITIVE_INFINITY) {
        break;
      }
    }
    return this.rootStyle;
  }

  getAttrStyle(elem: Element): csscasc.ElementStyle {
    // skip cases in which elements for XML other than HTML or SVG
    // have 'style' attribute not for CSS declaration
    if ((elem as any).style instanceof CSSStyleDeclaration) {
      const styleAttrValue = elem.getAttribute('style');
      if (styleAttrValue) {
        return csscasc.parseStyleAttribute(
            this.scope, this.validatorSet, this.xmldoc.url, styleAttrValue);
      }
    }
    return ({} as csscasc.ElementStyle);
  }

  /**
   * @return currently reached offset
   */
  getReachedOffset(): number {
    return this.lastOffset;
  }

  /**
   * Replay flow elements that were encountered since the given offset
   */
  replayFlowElementsFromOffset(offset: number): void {
    if (offset >= this.lastOffset) {
      return;
    }
    const context = this.context;
    const rootOffset = this.xmldoc.getElementOffset(this.root);
    if (offset < rootOffset) {
      const rootStyle = this.getStyle(this.root, false);
      asserts.assert(rootStyle);
      let flowName = csscasc.getProp(rootStyle, 'flow-into');
      let flowNameStr = flowName ?
          flowName.evaluate(context, 'flow-into').toString() :
          'body';
      const newFlowChunk = this.encounteredFlowElement(
          flowNameStr, rootStyle, this.root, rootOffset);
      if (this.boxStack.empty()) {
        this.boxStack.push(rootStyle, rootOffset, true, newFlowChunk);
      }
    }
    let node = this.xmldoc.getNodeByOffset(offset);
    let nodeOffset = this.xmldoc.getNodeOffset(node, 0, false);
    if (nodeOffset >= this.lastOffset) {
      return;
    }
    while (true) {
      if (node.nodeType != 1) {
        nodeOffset += node.textContent.length;
      } else {
        const elem = (node as Element);
        if (goog.DEBUG) {
          if (nodeOffset != this.xmldoc.getElementOffset(elem)) {
            throw new Error('Inconsistent offset');
          }
        }
        const style = this.getStyle(elem, false);
        let flowName = style['flow-into'];
        if (flowName) {
          let flowNameStr = flowName.evaluate(context, 'flow-into').toString();
          this.encounteredFlowElement(flowNameStr, style, elem, nodeOffset);
        }
        nodeOffset++;
      }
      if (nodeOffset >= this.lastOffset) {
        break;
      }
      let next = node.firstChild;
      if (next == null) {
        while (true) {
          next = node.nextSibling;
          if (next) {
            break;
          }
          node = node.parentNode;
          if (node === this.root) {
            return;
          }
        }
      }
      node = next;
    }
  }

  resetFlowChunkStream(flowListener: FlowListener): void {
    this.flowListener = flowListener;
    for (let i = 0; i < this.flowChunks.length; i++) {
      this.flowListener.encounteredFlowChunk(
          this.flowChunks[i], this.flows[this.flowChunks[i].flowName]);
    }
  }

  styleUntilFlowIsReached(flowName: string) {
    this.flowToReach = flowName;
    let offset = 0;
    while (true) {
      if (this.flowToReach == null) {
        break;
      }
      offset += 5000;
      if (this.styleUntil(offset, 0) == Number.POSITIVE_INFINITY) {
        break;
      }
    }
  }

  styleUntilIdIsReached(id: string) {
    if (!id) {
      return;
    }
    this.idToReach = id;
    let offset = 0;
    while (true) {
      if (!this.idToReach) {
        break;
      }
      offset += 5000;
      if (this.styleUntil(offset, 0) === Number.POSITIVE_INFINITY) {
        break;
      }
    }
    this.idToReach = null;
  }

  private encounteredFlowElement(
      flowName: string, style: csscasc.ElementStyle, elem: Element,
      startOffset: number): vtree.FlowChunk {
    let priority = 0;
    let linger = Number.POSITIVE_INFINITY;
    let exclusive = false;
    let repeated = false;
    let last = false;
    const optionsCV = style['flow-options'];
    if (optionsCV) {
      const options =
          cssprop.toSet(optionsCV.evaluate(this.context, 'flow-options'));
      exclusive = !!options['exclusive'];
      repeated = !!options['static'];
      last = !!options['last'];
    }
    const lingerCV = style['flow-linger'];
    if (lingerCV) {
      linger = cssprop.toInt(
          lingerCV.evaluate(this.context, 'flow-linger'),
          Number.POSITIVE_INFINITY);
    }
    const priorityCV = style['flow-priority'];
    if (priorityCV) {
      priority =
          cssprop.toInt(priorityCV.evaluate(this.context, 'flow-priority'), 0);
    }
    const breakBefore = this.breakBeforeValues[startOffset] || null;
    let flow = this.flows[flowName];
    if (!flow) {
      const parentFlowName = this.boxStack.lastFlowName();
      flow = this.flows[flowName] = new vtree.Flow(flowName, parentFlowName);
    }
    const flowChunk = new vtree.FlowChunk(
        flowName, elem, startOffset, priority, linger, exclusive, repeated,
        last, breakBefore);
    this.flowChunks.push(flowChunk);
    if (this.flowToReach == flowName) {
      this.flowToReach = null;
    }
    if (this.flowListener) {
      this.flowListener.encounteredFlowChunk(flowChunk, flow);
    }
    return flowChunk;
  }

  registerForcedBreakOffset(
      breakValue: string|null, offset: number, flowName: string) {
    if (breaks.isForcedBreakValue(breakValue)) {
      const forcedBreakOffsets = this.flows[flowName].forcedBreakOffsets;
      if (forcedBreakOffsets.length === 0 ||
          forcedBreakOffsets[forcedBreakOffsets.length - 1] < offset) {
        forcedBreakOffsets.push(offset);
      }
    }
    const previousValue = this.breakBeforeValues[offset];
    this.breakBeforeValues[offset] =
        breaks.resolveEffectiveBreakValue(previousValue, breakValue);
  }

  /**
   * @param startOffset current position in the document
   * @param lookup lookup window size for the next page
   * @return lookup offset in the document for the next page
   */
  styleUntil(startOffset: number, lookup: number): number {
    let targetSlippedOffset = -1;
    let slippedOffset;
    if (startOffset <= this.lastOffset) {
      slippedOffset = this.offsetMap.slippedByFixed(startOffset);
      targetSlippedOffset = slippedOffset + lookup;
      if (targetSlippedOffset < this.offsetMap.getMaxSlipped()) {
        // got to the desired point
        return this.offsetMap.fixedBySlipped(targetSlippedOffset);
      }
    }
    if (this.last == null) {
      return Number.POSITIVE_INFINITY;
    }
    const context = this.context;
    while (true) {
      let next = this.last.firstChild;
      if (next == null) {
        while (true) {
          if (this.last.nodeType == 1) {
            this.cascade.popElement((this.last as Element));
            this.primary = this.primaryStack.pop();
            let box = this.boxStack.pop(this.lastOffset);
            let breakAfter = null;
            if (box.afterBox) {
              const afterPseudoBreakBefore =
                  box.afterBox.getBreakValue('before');
              this.registerForcedBreakOffset(
                  afterPseudoBreakBefore,
                  box.afterBox.atBlockStart ?
                      this.boxStack.nearestBlockStartOffset(box) :
                      box.afterBox.offset,
                  box.flowName);
              breakAfter = box.afterBox.getBreakValue('after');
            }
            breakAfter = breaks.resolveEffectiveBreakValue(
                breakAfter, box.getBreakValue('after'));
            this.registerForcedBreakOffset(
                breakAfter, this.lastOffset, box.flowName);
          }
          next = this.last.nextSibling;
          if (next) {
            break;
          }
          this.last = this.last.parentNode;
          if (this.last === this.root) {
            this.last = null;
            if (startOffset < this.lastOffset) {
              if (targetSlippedOffset < 0) {
                slippedOffset = this.offsetMap.slippedByFixed(startOffset);
                targetSlippedOffset = slippedOffset + lookup;
              }
              if (targetSlippedOffset <= this.offsetMap.getMaxSlipped()) {
                // got to the desired point
                return this.offsetMap.fixedBySlipped(targetSlippedOffset);
              }
            }
            return Number.POSITIVE_INFINITY;
          }
        }
      }
      this.last = next;
      if (this.last.nodeType != 1) {
        this.lastOffset += this.last.textContent.length;
        this.boxStack.encounteredTextNode(this.last);
        if (this.primary) {
          this.offsetMap.addStuckRange(this.lastOffset);
        } else {
          this.offsetMap.addSlippedRange(this.lastOffset);
        }
      } else {
        const elem = (this.last as Element);
        const style = this.getAttrStyle(elem);
        this.primaryStack.push(this.primary);
        this.cascade.pushElement(elem, style, this.lastOffset);
        const id = elem.getAttribute('id') ||
            elem.getAttributeNS(base.NS.XML, 'id');
        if (id && id === this.idToReach) {
          this.idToReach = null;
        }
        if (!this.bodyReached && elem.localName == 'body' &&
            elem.parentNode == this.root) {
          this.postprocessTopStyle(style, true);
          this.bodyReached = true;
        }
        let box;
        const flowName = style['flow-into'];
        if (flowName) {
          const flowNameStr =
              flowName.evaluate(context, 'flow-into').toString();
          const newFlowChunk = this.encounteredFlowElement(
              flowNameStr, style, elem, this.lastOffset);
          this.primary = !!this.primaryFlows[flowNameStr];
          box = this.boxStack.push(
              style, this.lastOffset, elem === this.root, newFlowChunk);
        } else {
          box = this.boxStack.push(style, this.lastOffset, elem === this.root);
        }
        const blockStartOffset = this.boxStack.nearestBlockStartOffset(box);
        this.registerForcedBreakOffset(
            box.breakBefore, blockStartOffset, box.flowName);
        if (box.beforeBox) {
          const beforePseudoBreakAfter = box.beforeBox.getBreakValue('after');
          this.registerForcedBreakOffset(
              beforePseudoBreakAfter,
              box.beforeBox.atBlockStart ? blockStartOffset : box.offset,
              box.flowName);
        }
        if (this.primary) {
          if (box.displayValue() === ident.none) {
            this.primary = false;
          }
        }
        if (goog.DEBUG) {
          const offset = this.xmldoc.getElementOffset((this.last as Element));
          if (offset != this.lastOffset) {
            throw new Error('Inconsistent offset');
          }
        }
        this.styleMap[`e${this.lastOffset}`] = style;
        this.lastOffset++;
        if (this.primary) {
          this.offsetMap.addStuckRange(this.lastOffset);
        } else {
          this.offsetMap.addSlippedRange(this.lastOffset);
        }
        if (startOffset < this.lastOffset) {
          if (targetSlippedOffset < 0) {
            slippedOffset = this.offsetMap.slippedByFixed(startOffset);
            targetSlippedOffset = slippedOffset + lookup;
          }
          if (targetSlippedOffset <= this.offsetMap.getMaxSlipped()) {
            // got to the desired point
            return this.offsetMap.fixedBySlipped(targetSlippedOffset);
          }
        }
      }
    }
  }

  /**
   * @override
   */
  getStyle(element, deep) {
    let offset = this.xmldoc.getElementOffset(element);
    const key = `e${offset}`;
    if (deep) {
      offset = this.xmldoc.getNodeOffset(element, 0, true);
    }
    if (this.lastOffset <= offset) {
      this.styleUntil(offset, 0);
    }
    return this.styleMap[key];
  }

  /**
   * @override
   */
  processContent(element, styles) {}
}

export const columnProps = ['column-count', 'column-width', 'column-fill'];
