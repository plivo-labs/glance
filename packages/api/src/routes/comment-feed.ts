import { Hono } from 'hono'
import {
  assembleCommentFeed,
  authoredCandidatesStmt,
  mentionCandidatesStmt,
  ownedCandidatesStmt,
} from '../db/comment-feed'
import { foldMemberSpaceIds, foldSharedSiteRoles, memberSpaceIdsStmt, sharedSiteRoleStmts } from '../db/repo'
import { batchAll } from '../lib/d1'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

export const commentFeed = new Hono<AppEnv>()

commentFeed.use('*', requireAuth)

commentFeed.get('/feed', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const [authored, mentions, owned, memberSpaces, direct, viaGroup] = await batchAll(db, [
    authoredCandidatesStmt(db, user.id),
    mentionCandidatesStmt(db, user.id),
    ownedCandidatesStmt(db, user.id),
    memberSpaceIdsStmt(db, user.id),
    ...sharedSiteRoleStmts(db, user.id),
  ])
  const memberSpaceIds = foldMemberSpaceIds(memberSpaces)
  const sharedSiteRoles = foldSharedSiteRoles(direct, viaGroup)

  return c.json(assembleCommentFeed({ authored, mentions, owned, user, memberSpaceIds, sharedSiteRoles }))
})
