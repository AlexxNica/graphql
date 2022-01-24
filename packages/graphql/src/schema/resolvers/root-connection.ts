/*
 * Copyright (c) "Neo4j"
 * Neo4j Sweden AB [http://neo4j.com]
 *
 * This file is part of Neo4j.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { GraphQLResolveInfo } from "graphql";
import { InputTypeComposer, SchemaComposer } from "graphql-compose";
import { PageInfo } from "graphql-relay";
import { execute } from "../../utils";
import { translateRead } from "../../translate";
import { Node } from "../../classes";
import { Context } from "../../types";
import getNeo4jResolveTree from "../../utils/get-neo4j-resolve-tree";
import { isNeoInt } from "../../utils/utils";
import { createConnectionWithEdgeProperties } from "../pagination";

export default function rootConnectionResolver({ node, composer }: { node: Node; composer: SchemaComposer }) {
    async function resolve(_root: any, _args: any, _context: unknown, info: GraphQLResolveInfo) {
        const context = _context as Context;
        const resolveTree = getNeo4jResolveTree(info);

        const edgeTree = resolveTree.fieldsByTypeName[`${node.name}Connection`].edges;
        const nodeTree = edgeTree.fieldsByTypeName[`${node.name}Edge`].node;

        context.resolveTree = { ...nodeTree, args: resolveTree.args };
        context.isRootConnectionField = true;

        const [cypher, params] = translateRead({ context, node });

        const executeResult = await execute({
            cypher,
            params,
            defaultAccessMode: "READ",
            context,
        });

        // TODO: Ask neo4j team how to resolve this issue
        // TCK Tests Run the Resolver But Expect a Return Value
        // So in order to get the tests to pass we have to return
        // an empty connection. But it may be more preferable to
        // throw an error if there is no record, but that might
        // require modification to the "translateQuery" function
        let totalCount = 0;
        let edges: any[] = [];
        let pageInfo: PageInfo = {
            hasNextPage: false,
            hasPreviousPage: false,
            startCursor: null,
            endCursor: null,
        };

        if (executeResult.records[0]) {
            const record = executeResult.records[0].this;

            totalCount = isNeoInt(record.totalCount) ? record.totalCount.toNumber() : record.totalCount;

            const connection = createConnectionWithEdgeProperties({
                selectionSet: resolveTree,
                source: { edges },
                args: resolveTree.args,
                totalCount,
            });

            edges = connection.edges as any[];
            pageInfo = connection.pageInfo as PageInfo;
        }

        return {
            totalCount,
            edges,
            pageInfo,
        };
    }

    const rootEdge = composer.createObjectTC({
        name: `${node.name}Edge`,
        fields: {
            cursor: "String!",
            node: `${node.name}!`,
        },
    });

    const rootConnection = composer.createObjectTC({
        name: `${node.name}Connection`,
        fields: {
            totalCount: "Int!",
            pageInfo: "PageInfo!",
            edges: rootEdge.NonNull.List.NonNull,
        },
    });

    // since sort is not created when there is nothing to sort, we check for its existence
    let sortArg: InputTypeComposer<any> | undefined;
    try {
        sortArg = composer.getITC(`${node.name}Sort`);
        /* eslint-disable-next-line no-empty */
    } catch (e) {}

    return {
        type: rootConnection.NonNull,
        resolve,
        args: {
            first: "Int",
            after: "String",
            where: `${node.name}Where`,
            ...(sortArg ? { sort: sortArg.List } : {}),
            ...(node.fulltextDirective ? { fulltext: `${node.name}Fulltext` } : {}),
        },
    };
}
