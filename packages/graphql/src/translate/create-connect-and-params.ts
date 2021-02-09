import { Context, Node } from "../classes";
import { RelationField } from "../types";
import createWhereAndParams from "./create-where-and-params";
import createAuthAndParams from "./create-auth-and-params";
import { AUTH_FORBIDDEN_ERROR } from "../constants";

interface Res {
    connects: string[];
    params: any;
}

function createConnectAndParams({
    withVars,
    value,
    varName,
    relationField,
    parentVar,
    refNode,
    context,
    labelOverride,
    parentNode,
    fromCreate,
    insideDoWhen,
}: {
    withVars: string[];
    value: any;
    varName: string;
    relationField: RelationField;
    parentVar: string;
    context: Context;
    refNode: Node;
    labelOverride?: string;
    parentNode: Node;
    fromCreate?: boolean;
    insideDoWhen?: boolean;
}): [string, any] {
    function reducer(res: Res, connect: any, index): Res {
        const _varName = `${varName}${index}`;
        const inStr = relationField.direction === "IN" ? "<-" : "-";
        const outStr = relationField.direction === "OUT" ? "->" : "-";
        const relTypeStr = `[:${relationField.type}]`;

        res.connects.push(`WITH ${withVars.join(", ")}`);
        res.connects.push(`OPTIONAL MATCH (${_varName}:${labelOverride || relationField.typeMeta.name})`);

        if (connect.where) {
            const where = createWhereAndParams({
                varName: _varName,
                whereInput: connect.where,
                node: refNode,
                context,
            });
            res.connects.push(where[0]);
            res.params = { ...res.params, ...where[1] };
        }

        const preAuth = [...(!fromCreate ? [parentNode] : []), refNode].reduce(
            (result: Res, node, i) => {
                if (!node.auth) {
                    return result;
                }

                const [str, params] = createAuthAndParams({
                    entity: node,
                    operation: "connect",
                    context,
                    escapeQuotes: Boolean(insideDoWhen),
                    allow: { parentNode: node, varName: _varName, chainStr: `${_varName}${node.name}${i}_allow` },
                });

                if (!str) {
                    return result;
                }

                result.connects.push(str);
                result.params = { ...result.params, ...params };

                return result;
            },
            { connects: [], params: {} }
        ) as Res;

        if (preAuth.connects.length) {
            const quote = insideDoWhen ? `\\"` : `"`;
            res.connects.push(`WITH ${[...withVars, _varName].join(", ")}`);
            res.connects.push(
                `CALL apoc.util.validate(NOT(${preAuth.connects.join(
                    " AND "
                )}), ${quote}${AUTH_FORBIDDEN_ERROR}${quote}, [0])`
            );
            res.params = { ...res.params, ...preAuth.params };
        }

        /* 
           Replace with subclauses https://neo4j.com/developer/kb/conditional-cypher-execution/
           https://neo4j.slack.com/archives/C02PUHA7C/p1603458561099100 
        */
        res.connects.push(`FOREACH(_ IN CASE ${_varName} WHEN NULL THEN [] ELSE [1] END | `);
        res.connects.push(`MERGE (${parentVar})${inStr}${relTypeStr}${outStr}(${_varName})`);
        res.connects.push(`)`); // close FOREACH

        if (connect.connect) {
            const connects = (Array.isArray(connect.connect) ? connect.connect : [connect.connect]) as any[];
            connects.forEach((c) => {
                const reduced = Object.entries(c).reduce(
                    (r: Res, [k, v]) => {
                        const relField = refNode.relationFields.find((x) => k.startsWith(x.fieldName));
                        let newRefNode: Node;

                        if (relationField.union) {
                            const [modelName] = k.split(`${relationField.fieldName}_`).join("").split("_");
                            newRefNode = context.neoSchema.nodes.find((x) => x.name === modelName) as Node;
                        } else {
                            newRefNode = context.neoSchema.nodes.find(
                                (x) => x.name === (relField as RelationField).typeMeta.name
                            ) as Node;
                        }

                        const recurse = createConnectAndParams({
                            withVars: [...withVars, _varName],
                            value: v,
                            varName: `${_varName}_${k}`,
                            relationField: relField as RelationField,
                            parentVar: _varName,
                            context,
                            refNode: newRefNode as Node,
                            parentNode: refNode,
                        });
                        r.connects.push(recurse[0]);
                        r.params = { ...r.params, ...recurse[1] };

                        return r;
                    },
                    { connects: [], params: {} }
                ) as Res;

                res.connects.push(reduced.connects.join("\n"));
                res.params = { ...res.params, ...reduced.params };
            });
        }

        return res;
    }

    const { connects, params } = ((relationField.typeMeta.array ? value : [value]) as any[]).reduce(reducer, {
        connects: [],
        params: {},
    });

    return [connects.join("\n"), params];
}

export default createConnectAndParams;
