/* 
    Get one dataset collection detail
*/
import type { NextApiRequest, NextApiResponse } from 'next';
import { jsonRes } from '@fastgpt/service/common/response';
import { connectToDatabase } from '@/service/mongo';
import { authDatasetCollection } from '@fastgpt/service/support/permission/auth/dataset';
import { DatasetCollectionItemType } from '@fastgpt/global/core/dataset/type';

export default async function handler(req: NextApiRequest, res: NextApiResponse<any>) {
  try {
    await connectToDatabase();
    const { id } = req.query as { id: string };

    if (!id) {
      throw new Error('Id is required');
    }

    // 凭证校验
    const { collection, canWrite } = await authDatasetCollection({
      req,
      authToken: true,
      collectionId: id,
      per: 'r'
    });

    jsonRes<DatasetCollectionItemType>(res, {
      data: {
        ...collection,
        datasetId: collection.datasetId._id,
        canWrite
      }
    });
  } catch (err) {
    jsonRes(res, {
      code: 500,
      error: err
    });
  }
}
