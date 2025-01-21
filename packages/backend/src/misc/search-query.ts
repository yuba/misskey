/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { type WhereExpressionBuilder, Brackets } from 'typeorm';
import { sqlLikeEscape } from './sql-like-escape.js';

export type SearchCondition = { type: 'contains'; value: string; } |
{ type: 'not_contains'; value: string; } |
{ type: 'and'; subConditions: SearchCondition[]; } |
{ type: 'or'; subConditions: SearchCondition[]; } |
{ type: 'empty'; };

function joinConditions(
	left: SearchCondition,
	right: SearchCondition,
	context: 'and' | 'or' | 'not'): SearchCondition {
	if (right.type === 'empty') {
		return left;
	}

	// NOTはAND結合の一種
	const [rightMod, contextMod]: [SearchCondition, 'and' | 'or'] = context === 'not' ? [negate(right), 'and'] : [right, context];

	if (left.type === 'empty') {
		return rightMod;
	}

	if (left.type === contextMod) {
		if (rightMod.type === contextMod) {
			return concatConditionList(contextMod, left.subConditions, rightMod.subConditions);
		} else {
			return concatConditionList(contextMod, left.subConditions, [rightMod]);
		}
	} else if (rightMod.type === contextMod) {
		return concatConditionList(contextMod, [left], rightMod.subConditions);
	} else {
		return concatConditionList(contextMod, [left], [rightMod]);
	}
}

function negate(condition: SearchCondition): SearchCondition {
	switch (condition.type) {
		case 'contains':
			return { type: 'not_contains', value: condition.value };
		case 'not_contains':
			return { type: 'contains', value: condition.value };
		case 'and':
			return { type: 'or', subConditions: condition.subConditions.map(negate) };
		case 'or':
			return { type: 'and', subConditions: condition.subConditions.map(negate) };
		case 'empty':
			return condition;
	}
}

function concatConditionList(context: 'and' | 'or', left: SearchCondition[], right: SearchCondition[]): SearchCondition {
	let leftPruned: SearchCondition[];
	let rightPruned: SearchCondition[];
	if (context === 'and') {
		// ANDの場合は、姉妹条件を包含するような条件は冗長となるので削除する
		leftPruned = left.filter((leftCondition) => !right.some((rightCondition) => covers(leftCondition, rightCondition)));
		rightPruned = right.filter((rightCondition) => !leftPruned.some((leftCondition) => covers(rightCondition, leftCondition)));
	} else {
		// ORの場合は、姉妹条件に包含されるような条件は冗長となるので削除する
		leftPruned = left.filter((leftCondition) => !right.some((rightCondition) => covers(rightCondition, leftCondition)));
		rightPruned = right.filter((rightCondition) => !leftPruned.some((leftCondition) => covers(leftCondition, rightCondition)));
	}
	const combined = [...leftPruned, ...rightPruned];
	if (combined.length === 1) {
		return combined[0];
	} else {
		return { type: context, subConditions: combined };
	}
}

// 条件が他の条件の条件を包含しているか（＝より弱い条件であるか）
function covers(main: SearchCondition, other: SearchCondition): boolean {
	switch (main.type) {
		case 'contains':
			switch (other.type) {
				case 'contains':
					return other.value.includes(main.value);
				case 'and':
				case 'or':
					return other.subConditions.every((subCondition) => covers(main, subCondition));
			}
			break;
		case 'not_contains':
			switch (other.type) {
				case 'not_contains':
					return main.value.includes(other.value);
				case 'and':
				case 'or':
					return other.subConditions.every((subCondition) => covers(main, subCondition));
			}
			break;
		case 'and':
		case 'or':
			return main.subConditions.every((subCondition) => covers(subCondition, other));
	}
	return false;
}

// 検索文字列を分解したトークンの種別：小文字化テキストか、制御か、もう読む文字がないか
type Token = string | { control: '-' | '+' | '(' | ')' | 'or'; } | null;
class Tokenizer {
	private pos = 0;

	constructor(private readonly q: string) {
	}

	public getNext(): Token {
		let inQuote = false;
		let inEscape = false;
		let token = '';
		for (; this.pos < this.q.length; ++this.pos) {
			const c = this.q[this.pos];
			switch (c) {
				case '"':
					if (inEscape) {
						token += '"';
					} else if (inQuote) {
						++this.pos;
						return token; // クオート閉じの場合はトークンが「OR」でもりOR制御トークンでなくリテラル「OR」テキストトークンとして返す
					} else if (token.length > 0) {
						return token;
					} else {
						inQuote = true;
					}
					inEscape = false;
					break;
				case '\\':
					if (inEscape) {
						token += '\\';
						inEscape = false;
					} else {
						inEscape = true;
					}
					break;
				case '(':
				case ')':
				case '+':
				case '-':
					if (inEscape || inQuote) {
						token += c;
					} else if (token.length > 0) {
						// ここまで読みためているテキストトークンをいったん返してしまう
						return (token === 'or') ? { control: 'or' } : token;
					} else {
						++this.pos;
						return { control: c };
					}
					inEscape = false;
					break;
				default:
					// eslint-disable-next-line no-irregular-whitespace
					if (inEscape || inQuote || !c.match(/[\s　]/)) {
						token += c.toLowerCase();
					} else if (token.length > 0) {
						// 空白文字。テキストトークンの読み終わり
						++this.pos;
						return (token === 'or') ? { control: 'or' } : token;
					} else {
						// 先頭の空白や連続した空白の読み飛ばし
					}
					inEscape = false;
					break;
			}
		}
		return token.length === 0 ? null : (token === 'or' && !inQuote) ? { control: 'or' } : token;
	};
}

function parsePartialSearchString(
	tokenizer: Tokenizer,
	isRoot: boolean): SearchCondition {
	let currentCondition: SearchCondition = { type: 'empty' };
	let context: 'and' | 'or' | 'not' = 'and';
	for (let token = tokenizer.getNext(); token != null; token = tokenizer.getNext()) {
		if (typeof token === 'object') {
			switch (token.control) {
				case '(': {
					const foundCondition = parsePartialSearchString(
						tokenizer,
						/*isRoot = */ false,
					);
					currentCondition = joinConditions(currentCondition, foundCondition, context);
					context = 'and';
					break;
				}
				case ')':
					if (!isRoot) return currentCondition;
					else {
						// ルート階層で閉じ括弧が来た場合は先頭に開き括弧を補って解釈する
						// = 単にコンテキストをクリアするだけ
						context = 'and';
					}
					break;
				case 'or':
					context = 'or';
					break;
				case '+':
					context = 'and';
					break;
				case '-':
					context = 'not';
					break;
			}
		} else {
			if (token.length === 0) {
				// 空文字列（""という検索入力で発生する）は無視
			} else {
				const foundCondition: SearchCondition = { type: 'contains', value: token };
				currentCondition = joinConditions(currentCondition, foundCondition, context);
			}
			context = 'and';
		}
	}
	return currentCondition; // ルート階層でなければ、閉じ括弧がなかった場合に閉じ括弧を補って解釈したことになる
}

export function parseSearchString(q: string) {
	const tokenizer = new Tokenizer(q);
	return parsePartialSearchString(tokenizer, true);
}

export function appendCondToQuery(
	condition: SearchCondition,
	query: WhereExpressionBuilder): void {
	let i = 0; // SQL内のパラメータはすべて違えないといけないので連番で生成する

	const appendCondToAndContext = (
		condition: SearchCondition,
		query: WhereExpressionBuilder,
	) => {
		switch (condition.type) {
			case 'contains':
				++i;
				query.andWhere(`LOWER(coalesce(note.cw, '')||note.text) LIKE :q${i}`, {
					[`q${i}`]: `%${sqlLikeEscape(condition.value)}%`,
				});
				break;
			case 'not_contains':
				++i;
				query.andWhere(`LOWER(coalesce(note.cw, '')||note.text) NOT LIKE :q${i}`, {
					[`q${i}`]: `%${sqlLikeEscape(condition.value)}%`,
				});
				break;
			case 'and':
				condition.subConditions.forEach((subCondition) => appendCondToAndContext(subCondition, query));
				break;
			case 'or':
				query.andWhere(
					new Brackets((qb) => condition.subConditions.forEach(
						(subCondition) => appendCondToOrContext(subCondition, qb))));
				break;
		}
	};

	const appendCondToOrContext = (
		condition: SearchCondition,
		query: WhereExpressionBuilder,
	) => {
		switch (condition.type) {
			case 'contains':
				++i;
				query.orWhere(`LOWER(coalesce(note.cw, '')||note.text) LIKE :q${i}`, {
					[`q${i}`]: `%${sqlLikeEscape(condition.value)}%`,
				});
				break;
			case 'not_contains':
				++i;
				query.orWhere(`LOWER(coalesce(note.cw, '')||note.text) NOT LIKE :q${i}`, {
					[`q${i}`]: `%${sqlLikeEscape(condition.value)}%`,
				});
				break;
			case 'and':
				query.orWhere(
					new Brackets((qb) => condition.subConditions.forEach(
						(subCondition) => appendCondToAndContext(subCondition, qb))));
				break;
		}
	};

	return appendCondToAndContext(condition, query);
}
