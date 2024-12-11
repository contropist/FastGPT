import { MongoApp } from '@fastgpt/service/core/app/schema';
import { AppListItemType } from '@fastgpt/global/core/app/type';
import { NextAPI } from '@/service/middleware/entry';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';
import {
  PerResourceTypeEnum,
  ReadPermissionVal
} from '@fastgpt/global/support/permission/constant';
import { AppPermission } from '@fastgpt/global/support/permission/app/controller';
import { ApiRequestProps } from '@fastgpt/service/type/next';
import { ParentIdType } from '@fastgpt/global/common/parentFolder/type';
import { parseParentIdInMongo } from '@fastgpt/global/common/parentFolder/utils';
import { AppFolderTypeList, AppTypeEnum } from '@fastgpt/global/core/app/constants';
import { AppDefaultPermissionVal } from '@fastgpt/global/support/permission/app/constant';
import { authApp } from '@fastgpt/service/support/permission/app/auth';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';
import { replaceRegChars } from '@fastgpt/global/common/string/tools';
import { getGroupPer } from '@fastgpt/service/support/permission/controller';
import { getGroupsByTmbId } from '@fastgpt/service/support/permission/memberGroup/controllers';

export type ListAppBody = {
  parentId?: ParentIdType;
  type?: AppTypeEnum | AppTypeEnum[];
  getRecentlyChat?: boolean;
  searchKey?: string;
};

/* 
  获取 APP 列表权限
  1. 校验 folder 权限和获取 team 权限（owner 单独处理）
  2. 获取 team 下所有 app 权限。获取我的所有组。并计算出我所有的app权限。
  3. 过滤我有的权限的 app，以及当前 parentId 的 app（由于权限继承问题，这里没法一次性根据 id 去获取）
  4. 根据过滤条件获取 app 列表
  5. 遍历搜索出来的 app，并赋予权限（继承的 app，使用 parent 的权限）
  6. 再根据 read 权限进行一次过滤。
*/

async function handler(req: ApiRequestProps<ListAppBody>): Promise<AppListItemType[]> {
  const { parentId, type, getRecentlyChat, searchKey } = req.body;

  // Auth user permission
  const [{ tmbId, teamId, permission: teamPer }] = await Promise.all([
    authUserPer({
      req,
      authToken: true,
      authApiKey: true,
      per: ReadPermissionVal
    }),
    ...(parentId
      ? [
          authApp({
            req,
            authToken: true,
            authApiKey: true,
            appId: parentId,
            per: ReadPermissionVal
          })
        ]
      : [])
  ]);

  // Get team all app permissions
  const [perList, myGroupMap] = await Promise.all([
    MongoResourcePermission.find({
      resourceType: PerResourceTypeEnum.app,
      teamId,
      resourceId: {
        $exists: true
      }
    }).lean(),
    getGroupsByTmbId({
      tmbId,
      teamId
    }).then((item) => {
      const map = new Map<string, 1>();
      item.forEach((item) => {
        map.set(String(item._id), 1);
      });
      return map;
    })
  ]);
  // Get my permissions
  const myPerList = perList.filter(
    (item) => String(item.tmbId) === String(tmbId) || myGroupMap.has(String(item.groupId))
  );

  const findAppsQuery = (() => {
    if (getRecentlyChat) {
      return {
        // get all chat app
        teamId,
        type: { $in: [AppTypeEnum.workflow, AppTypeEnum.simple, AppTypeEnum.plugin] }
      };
    }

    // Filter apps by permission, if not owner, only get apps that I have permission to access
    const idList = { _id: { $in: myPerList.map((item) => item.resourceId) } };
    const appPerQuery = teamPer.isOwner
      ? {}
      : parentId
        ? {
            $or: [idList, parseParentIdInMongo(parentId)]
          }
        : idList;

    const searchMatch = searchKey
      ? {
          $or: [
            { name: { $regex: new RegExp(`${replaceRegChars(searchKey)}`, 'i') } },
            { intro: { $regex: new RegExp(`${replaceRegChars(searchKey)}`, 'i') } }
          ]
        }
      : {};

    if (searchKey) {
      return {
        ...appPerQuery,
        teamId,
        ...searchMatch
      };
    }

    return {
      ...appPerQuery,
      teamId,
      ...(type && (Array.isArray(type) ? { type: { $in: type } } : { type })),
      ...parseParentIdInMongo(parentId)
    };
  })();
  const limit = (() => {
    if (getRecentlyChat) return 15;
    if (searchKey) return 20;
    return 1000;
  })();

  const myApps = await MongoApp.find(
    findAppsQuery,
    '_id parentId avatar type name intro tmbId updateTime pluginData inheritPermission'
  )
    .sort({
      updateTime: -1
    })
    .limit(limit)
    .lean();

  // Add app permission and filter apps by read permission
  const formatApps = myApps
    .map((app) => {
      const { Per, privateApp } = (() => {
        const getPer = (appId: string) => {
          const tmbPer = myPerList.find(
            (item) => String(item.resourceId) === appId && !!item.tmbId
          )?.permission;
          const groupPer = getGroupPer(
            myPerList
              .filter((item) => String(item.resourceId) === appId && !!item.groupId)
              .map((item) => item.permission)
          );

          // Count app collaborators
          const clbCount = perList.filter(
            (item) => String(item.resourceId) === String(app._id)
          ).length;

          return {
            Per: new AppPermission({
              per: tmbPer ?? groupPer ?? AppDefaultPermissionVal,
              isOwner: String(app.tmbId) === String(tmbId) || teamPer.isOwner
            }),
            privateApp: AppFolderTypeList.includes(app.type) ? clbCount <= 1 : clbCount === 0
          };
        };

        // Inherit app
        if (app.inheritPermission && app.parentId && !AppFolderTypeList.includes(app.type)) {
          return getPer(String(app.parentId));
        } else {
          return getPer(String(app._id));
        }
      })();

      return {
        ...app,
        permission: Per,
        privateApp
      };
    })
    .filter((app) => app.permission.hasReadPer);

  return formatApps.map((app) => ({
    _id: app._id,
    tmbId: app.tmbId,
    avatar: app.avatar,
    type: app.type,
    name: app.name,
    intro: app.intro,
    updateTime: app.updateTime,
    permission: app.permission,
    pluginData: app.pluginData,
    inheritPermission: app.inheritPermission ?? true,
    private: app.privateApp
  }));
}

export default NextAPI(handler);
