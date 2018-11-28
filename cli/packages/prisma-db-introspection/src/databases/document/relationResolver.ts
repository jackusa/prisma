import { SamplingStrategy, ICollectionDescription, IDocumentConnector } from './documentConnector'
import { IGQLType, IGQLField } from 'prisma-datamodel'
import { Data } from './data';
import { ModelSampler } from './modelSampler'

export interface IRelationResolver<InternalCollectionType> {
  resolve(types: IGQLType[], resolver: IDocumentConnector<InternalCollectionType>, schemaName: string) : Promise<void>
}

interface IRelationScore {
  hits: number,
  misses: number
}

export class RelationResolver<InternalCollectionType> implements IRelationResolver<InternalCollectionType> {
  private samplingStrategy: SamplingStrategy
  private ratioThreshold: number

  constructor(samplingStrategy: SamplingStrategy = SamplingStrategy.Random, threshold: number = 0.5) {
    this.samplingStrategy = samplingStrategy
    this.ratioThreshold = threshold
  }

  public async resolve(types: IGQLType[], connector: IDocumentConnector<InternalCollectionType>, schemaName: string) {
    const allCollections = await connector.getInternalCollections(schemaName)
    for(const type of types) {
      if(!type.isEmbedded) {
        const [collection] = allCollections.filter(x => x.name === type.name)

        if(collection === undefined) {
          throw new Error(`Missmatch between collections and given types: Collection ${type.name} does not exist.`)
        }

        const iterator = await connector.sample(collection.collection, this.samplingStrategy)
        const context = new RelationResolveContext<InternalCollectionType>(type, allCollections, connector)
        while(await iterator.hasNext()) {
          const data = await iterator.next()
          await context.attemptResolve(data)
        }
        await iterator.close()

        context.connectRelationsIfResolved(types, this.ratioThreshold)
      }
    }
  }
}

class RelationResolveContext<Type> {
  private type: IGQLType
  // First dimension: Field name, second: Remote Collection
  private fieldScores : { [key: string] : { [key: string] : IRelationScore } }
  private embeddedTypes : { [key: string] : RelationResolveContext<Type> }
  private collections: ICollectionDescription<Type>[]
  private connector: IDocumentConnector<Type>

  constructor(type: IGQLType, collections: ICollectionDescription<Type>[], connector: IDocumentConnector<Type>) {
    this.type = type
    this.collections = collections
    this.connector = connector

    for(const field of type.fields) {
      if(!this.hasError(field)) {
        if(typeof field.type  == 'string') {
          // Primitive field
          if(field.relationName == ModelSampler.ErrorType) {
            for(const collection of this.collections) {
              this.fieldScores[field.name][collection.name] = { hits: 0, misses: 0 }
            }
          }
        } else {
          // Embedded field
          this.embeddedTypes[field.name] = new RelationResolveContext<Type>(field.type, this.collections, this.connector)
        }
      }
    }
  }


  private async hasError(obj: IGQLField | IGQLType) {
    return obj.comments !== undefined &&
           obj.comments.some(x => x.isError)
  }

  public async attemptResolve(data: Data) {
    // TODO: Warn on model missmatch?
    for(const field of this.type.fields) {
      if(!this.hasError(field)) {
        if(typeof field.type  == 'string') {
          // Primitive field
          if(field.relationName == ModelSampler.ErrorType) {
            if(data[field.name] !== undefined) {
              const value = data[field.name]
              for(const collection of this.collections) {
                if(await this.connector.exists(collection.collection, value)) {
                  this.fieldScores[field.name][collection.name].hits += 1
                } else {
                  this.fieldScores[field.name][collection.name].misses += 1
                }
              }
            }
          }
        } else {
          // Embedded field
          if(data[field.name] !== undefined) {
            this.embeddedTypes[field.name].attemptResolve(data[field.name])
          }
        }
      }
    }
  }

  public connectRelationsIfResolved(availableTypes: IGQLType[], threshold: number = 0.5) {
    // Recursive, as above, find maximal candidate, check if is over threshold, connect all. 
    for(const field of this.type.fields) {
      if(!this.hasError(field)) {
        if(typeof field.type  == 'string') {
          let bestRatio = 0
          let bestCandidate: ICollectionDescription<Type> | null = null
          for(const collection of this.collections) {
            const score = this.fieldScores[field.name][collection.name]
            const ratio = score.misses + score.hits === 0 ? 0 : score.hits / (score.misses + score.hits)

            if(ratio > bestRatio || bestCandidate === null) {
              bestCandidate = collection
            }
          }

          if(bestRatio > threshold && bestCandidate !== null) {
            const candidateName = bestCandidate.name
            const [foreignType] = availableTypes.filter(x => x.name == candidateName)

            if(foreignType === undefined) {
              throw new Error(`Missmatch between collections and given types: Type ${candidateName} does not exist.`)
            }

            field.type = foreignType
            field.relationName = null
          }
        }
      }
    }

    return this.type
  }
}